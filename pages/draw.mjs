// Drawings only Git Crafter needs: the process trail (one per map), the
// goal strip, the model routes, and the systems, token and delegation maps,
// plus their icons. Like quality/render/charts.mjs, which both pages share,
// each takes numbers and labels and returns an SVG string; page.css and
// site.css color them.

import { esc, finite, fmt, fmtCompact, STATUS_WORD } from "../quality/render/charts.mjs";

const r1 = (n) => String(Math.round(n * 10) / 10);

// 16 x 16 strokes in currentColor, the shared sprite's style (quality/render/icons.mjs), under their
// own "c-" prefix so they never collide with its "i-" and "g-" symbols.
const SYMBOLS = {
  plan: '<rect x="3" y="2.75" width="10" height="11.5" rx="1.5"/><path d="M6 2.75h4v2H6zM5.75 8h4.5M5.75 10.75h3"/>',
  sessions: '<path d="M8 2 14 5 8 8 2 5z"/><path d="m2 8 6 3 6-3M2 11l6 3 6-3"/>',
  build: '<path d="M5.5 4 1.75 8l3.75 4M10.5 4l3.75 4-3.75 4M9 3 7 13"/>',
  ci: '<circle cx="8" cy="8" r="6.25"/><path d="M6.5 5.25v5.5L10.75 8z" fill="currentColor"/>',
  review: '<circle cx="7" cy="7" r="4.25"/><path d="m10.25 10.25 3.5 3.5"/>',
  merge: '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="8" r="1.5"/><path d="M4.5 5v6M4.5 5c0 2.5 2 3 5.5 3"/>',
  deploy: '<path d="M4.5 12.5h-.25A2.75 2.75 0 0 1 4 7.05 4 4 0 0 1 11.75 6a3.25 3.25 0 0 1 .5 6.5h-.75"/><path d="M8 13.75v-5M6 10.5l2-2 2 2"/>',
  measure: '<path d="M2.25 11.5a5.75 5.75 0 1 1 11.5 0"/><path d="m8 11.5 3-4"/><circle cx="8" cy="11.5" r=".75" fill="currentColor"/>',
  production: '<circle cx="8" cy="8" r="6.25"/><path d="M1.75 8h12.5M8 1.75c2 2 2 10.5 0 12.5M8 1.75c-2 2-2 10.5 0 12.5"/>',
  speed: '<path d="M9 1.75 3.5 9.25h4l-1 5 5.5-7.5h-4z"/>',
  tokens: '<ellipse cx="8" cy="4.5" rx="5" ry="2"/><path d="M3 4.5v3.5c0 1.1 2.25 2 5 2s5-.9 5-2V4.5M3 8v3.5c0 1.1 2.25 2 5 2s5-.9 5-2V8"/>',
  repo: '<path d="M3.5 2.25h8.75v10H5a1.5 1.5 0 0 0-1.5 1.5zM3.5 13.75a1.5 1.5 0 0 0 1.5 1.5h7.25v-3"/>',
  push: '<path d="M8 12V2.75M4.75 6 8 2.75 11.25 6M3 14.25h10"/>',
  mail: '<rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1.5"/><path d="m2.25 4 5.75 4.75L13.75 4"/>',
  shield: '<path d="M8 1.75 13.25 3.75v4c0 3.25-2.25 5.5-5.25 6.5-3-1-5.25-3.25-5.25-6.5v-4z"/>',
  key: '<circle cx="5" cy="10.5" r="2.75"/><path d="m7 8.5 6.25-6.25M11 4.5l1.75 1.75M9.5 6l1.25 1.25"/>',
  trash: '<path d="M2.75 4.25h10.5M6.25 4.25V2.5h3.5v1.75M4.25 4.25l.75 9.5h6l.75-9.5"/>',
  clock: '<circle cx="8" cy="8" r="6"/><path d="M8 4.75V8l2.25 1.5"/>',
  // Blockers: a no-entry sign, as on the site's Blockers tab.
  blockers: '<circle cx="8" cy="8" r="6.25"/><path d="m3.6 12.4 8.8-8.8"/>',
  // Simplicity: lines that shorten.
  simplicity: '<path d="M2.5 4h11M2.5 8h7M2.5 12h3"/>',
};

// Every icon id the Git Crafter sprite draws.
export const ICON_IDS = Object.keys(SYMBOLS);

// The Git Crafter icon sprite: one hidden <svg> of <symbol id="c-<id>">, placed once per page.
export const COS_SPRITE = `<svg class="sprite" aria-hidden="true" focusable="false" width="0" height="0">${Object.entries(SYMBOLS)
  .map(([id, body]) => `<symbol id="c-${id}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</symbol>`)
  .join("")}</svg>`;

// One icon from the Git Crafter sprite, hidden from screen readers.
export const cicon = (id, cls = "ic") => `<svg class="${cls}" aria-hidden="true"><use href="#c-${esc(id)}"/></svg>`;

// ---- The process trail --------------------------------------------------

// The critical path runs left to right on one line; a step off it (Measure)
// sits past its end, and a thin line carries what it learns back into the
// first step. Steps spread over the width, never closer than GAP.
export const TRAIL = { width: 1240, height: 260, y: 110, x0: 70, r: 26 };
export const GAP = 104;
// Each step's x and y on the trail: the critical path on one line, the
// steps off it below.
export function places(steps, critical) {
  const n = steps.length;
  const gap = n > 1 ? Math.max(GAP, (TRAIL.width - 2 * TRAIL.x0) / (n - 1)) : 0;
  const x = Object.fromEntries(steps.map((s, i) => [s.id, TRAIL.x0 + i * gap]));
  const crit = steps.filter((s) => critical.has(s.id));
  return {
    x,
    gap,
    width: Math.max(TRAIL.width, 2 * TRAIL.x0 + (n - 1) * gap),
    first: steps[0].id,
    end: (crit.at(-1) ?? steps.at(-1)).id,
    last: steps.at(-1).id,
  };
}

// A readout's value, plus a hidden variant for each repo with its own value;
// the client shows the variant for the repo the filter picks.
const shown = (ro, v) => (!finite(v) ? "–" : ro.unit === "on/off" ? (v ? "on" : "off") : fmtCompact(v, ro.unit === "tokens" ? "" : ro.unit === "%" ? "%" : ro.unit));
const valueLine = (ro, fmtV = (v) => shown(ro, v)) => {
  if (!ro) return "";
  const each = Object.entries(ro.byRepo ?? {}).map(([r, v]) => `<tspan class="t-v" data-r="${esc(r)}" hidden>${esc(fmtV(v))}</tspan>`);
  return `<tspan class="t-v" data-r="">${esc(fmtV(ro.value))}</tspan>${each.join("")}`;
};

// A share fills its ring by how good it is: the value, or 100 less it when
// lower is better. Anything but a share draws no ring.
const ringShare = (ro, v) => (ro.unit === "%" && finite(v) ? Math.min(Math.max(ro.def?.direction === "lower" ? 100 - v : v, 0), 100) : null);

// map: one of the repo's maps; readouts: { [step id]: stepReadout() };
// critical: Set of step ids; selected: a step id. Each anchor carries the map
// id, so two maps on one page never share one.
export function trail(map, readouts, critical, selected) {
  const steps = map.steps;
  const key = (s) => `${map.id}-${s.id}`;
  const P = places(steps, critical);
  const T = { ...TRAIL, x: P.x, width: P.width };
  const y = T.y;
  const x0 = T.x[P.first];
  const mainEnd = T.x[P.end];
  const xn = T.x[P.last];
  const main = `<path class="t-main" d="M${x0} ${y}H${mainEnd}"/><path class="t-off" d="M${mainEnd} ${y}H${xn}"/>`;
  const names = (id) => steps.find((s) => s.id === id)?.name ?? id;
  const back = `<path class="t-back" d="M${xn} ${y + T.r + 8}V${T.height - 22}H22V${y}H${x0 - T.r - 8}"/><path class="t-arrow" d="M${x0 - T.r - 14} ${y - 5} ${x0 - T.r - 6} ${y} ${x0 - T.r - 14} ${y + 5}"/><text class="t-note" x="${(x0 + xn) / 2}" y="${T.height - 6}">what ${esc(names(P.last))} finds feeds the next ${esc(names(P.first))}</text>`;
  const hitW = Math.min(132, P.gap - 4 || 132);
  const nodes = steps.map((s, i) => stepNode({ key: key(s), s, i, ro: readouts[s.id], x: T.x[s.id], y, hitW, crit: critical.has(s.id), selected })).join("");
  return `<svg class="trail" viewBox="0 0 ${T.width} ${T.height}" role="group" aria-label="${esc(map.name)}: ${steps.length} steps; the critical path is the thick line">${main}${back}${nodes}</svg>`;
}

// A step's tooltip: its number and name, then its metric's label, value and status in words.
function stepTip(s, i, ro) {
  const value = !finite(ro.value) ? "not measured" : ro.unit === "on/off" ? shown(ro, ro.value) : fmt(ro.value, ro.unit);
  const status = STATUS_WORD[ro.status] && finite(ro.value) ? `; ${STATUS_WORD[ro.status]}` : "";
  return `${i + 1} ${s.name}; ${ro.label}: ${value}${status}`;
}

// One step's link at (x, y): ring, node, number, name and value line; every map shape draws it, so the client sees one markup.
export function stepNode({ key, s, i, ro, x, y, hitW, crit, selected }) {
  const R = TRAIL.r;
  const tip = stepTip(s, i, ro);
  const arc = (v, r) =>
    `<circle class="t-ring" data-r="${esc(r)}"${r ? " hidden" : ""} cx="${x}" cy="${y}" r="${R + 7}" pathLength="100" stroke-dasharray="${finite(v) ? r1(v) : 0} 100" transform="rotate(-90 ${x} ${y})"/>`;
  const ring = `<circle class="t-track" cx="${x}" cy="${y}" r="${R + 7}"/>${
    ro.unit === "%" ? `<g data-vg="">${arc(ringShare(ro, ro.value), "")}${Object.entries(ro.byRepo ?? {}).map(([r, v]) => arc(ringShare(ro, v), r)).join("")}</g>` : ""
  }`;
  // Status by shape and color on the node itself, so a map reads without opening a step.
  // It sits past the ring (radius R + 7) at 45 degrees, so it covers none of the ring's share (#688).
  const M = R + 7;
  const mark = STATUS_WORD[ro.status] ? `<circle class="t-stbg" cx="${x + M}" cy="${y - M}" r="10"/><use class="t-st" href="#g-${esc(ro.status)}" x="${x + M - 8}" y="${y - M - 8}" width="16" height="16"/>` : "";
  const hit = `<rect class="t-hit" x="${x - hitW / 2}" y="${y - 50}" width="${hitW}" height="132" rx="10"/>`;
  // The step's one metric under its name, keyed by its kind: quality, speed or consumption.
  const line = `<tspan class="t-val" data-vg="" x="${x}" y="${y + 70}">${ro.kind ? `<tspan class="t-k">${esc(ro.kind)}</tspan> ` : ""}${valueLine(ro)}</tspan>`;
  // The words it shows name the link, spaced in one text (axe label-content-name-mismatch, WCAG 2.5.3);
  // the tip is its description, never part of its name.
  const words = `<text><tspan class="t-num" x="${x}" y="${y + 7}">${i + 1}</tspan> <tspan class="t-name" x="${x}" y="${y + 50}">${esc(s.short ?? s.name)}</tspan> ${line}</text>`;
  return `<a class="t-step${crit ? " crit" : ""}" href="#step-${esc(key)}" data-step="${esc(key)}"${s.id === selected ? ' aria-current="step"' : ""} data-tip="${esc(tip)}"><desc>${esc(tip)}</desc>${hit}<circle class="t-halo" cx="${x}" cy="${y}" r="${R + 15}"/>${ring}<circle class="t-node" cx="${x}" cy="${y}" r="${R}"/>${mark}${words}</a>`;
}

// ---- The goal strip ------------------------------------------------------

// One row per outcome; each goal a status glyph placed by position(): left of
// the near tick misses, between near and goal is near, past the goal meets.
// A goal with no data sits in its own column at the left.
const STRIP = { width: 1000, label: 288, nm: 318, x0: 350, x1: 985, row: 54, top: 34, lo: -1, hi: 2 };

// The outcome strip: each outcome's position against near and goal.
export function strip(outcomes) {
  const S = STRIP;
  const h = S.top + outcomes.length * S.row + 8;
  const x = (p) => S.x0 + ((p - S.lo) / (S.hi - S.lo)) * (S.x1 - S.x0);
  const zones = [
    ["misses", S.lo, 0],
    ["near", 0, 1],
    ["meets", 1, S.hi],
  ]
    .map(([z, a, b]) => `<rect class="z-${z}" x="${r1(x(a))}" y="${S.top - 6}" width="${r1(x(b) - x(a))}" height="${h - S.top - 2}"/><text class="s-zone" x="${r1((x(a) + x(b)) / 2)}" y="${S.top - 14}">${z}</text>`)
    .join("");
  const ticks = `<path class="s-tick" d="M${r1(x(0))} ${S.top - 6}V${h - 8}M${r1(x(1))} ${S.top - 6}V${h - 8}"/><text class="s-nmh" x="${S.nm}" y="${S.top - 14}">none</text>`;
  const rows = outcomes
    .map((o, i) => {
      const cy = S.top + i * S.row + S.row / 2;
      const placed = [];
      const marks = o.goals
        .map((g) => {
          const gx = g.pos === null ? S.nm : x(g.pos);
          let dy = 0;
          while (placed.some((p) => Math.abs(p.x - gx) < 16 && p.dy === dy)) dy = dy <= 0 ? -dy + 13 : -dy;
          placed.push({ x: gx, dy });
          // A lower bound (the entry's bound) reads "≥ x", as on the Metrics page.
          const shown = finite(g.value) ? `${g.entry?.bound ? "≥ " : ""}${fmt(g.value, g.unit)}` : "not measured";
          const tip = `${g.label}: ${shown}; goal ${g.direction === "higher" ? "≥" : "≤"} ${fmt(g.goal, g.unit)}`;
          return `<a class="s-mark" href="#goal-${esc(g.id)}" aria-label="${esc(tip)}" data-tip="${esc(tip)}" data-outcome="${esc(o.id)}"><circle class="s-hit" cx="${r1(gx)}" cy="${r1(cy + dy)}" r="13"/><use href="#g-${g.status}" x="${r1(gx - 8)}" y="${r1(cy + dy - 8)}" width="16" height="16"/></a>`;
        })
        .join("");
      const score = finite(o.score) ? String(o.score) : "–";
      return `<g class="s-row" data-outcome="${esc(o.id)}"><path class="s-base" d="M0 ${cy + S.row / 2}H${S.x1}"/><use class="s-ic" href="#c-${esc(o.icon)}" x="0" y="${cy - 9}" width="18" height="18"/><text class="s-name" x="26" y="${cy + 5}">${esc(o.name)}</text><use href="#g-${o.status}" x="${S.label - 30}" y="${cy - 8}" width="16" height="16"/><text class="s-score" x="${S.label - 34}" y="${cy + 6}">${score}</text>${marks}</g>`;
    })
    .join("");
  return `<svg class="strip" viewBox="0 0 ${S.width} ${h}" role="group" aria-label="Every goal placed against its near edge and its target, by outcome">${zones}${ticks}${rows}</svg>`;
}

// ---- Model routes -----------------------------------------------------------

// Work fans out to the models that take it. A route is as thick as its share
// where data measures one; with no data, routes are drawn alike and unlabeled.
export function routes(list) {
  const [w, h, x0, x1] = [900, 210, 110, 560];
  const ys = list.map((_, i) => 40 + i * ((h - 80) / Math.max(list.length - 1, 1)));
  const paths = list
    .map((r, i) => {
      const width = finite(r.share) ? Math.max(1, (r.share / 100) * 14) : 4;
      const d = `M${x0 + 30} ${h / 2}C${x0 + 180} ${h / 2} ${x1 - 200} ${ys[i]} ${x1 - 26} ${ys[i]}`;
      return `<g data-tip="${esc(r.tip)}" tabindex="0"><path class="rt-path${finite(r.share) ? " sh" : ""}" d="${d}" style="stroke-width:${r1(width)}"/><circle class="cm-c" cx="${x1}" cy="${ys[i]}" r="22"/><use href="#c-${esc(r.icon)}" x="${x1 - 10}" y="${ys[i] - 10}" width="20" height="20"/><text class="rt-l" x="${x1 + 34}" y="${ys[i] + 5}">${esc(r.label)}</text>${
        r.shareText ? `<text class="rt-s" x="${x1 + 34}" y="${ys[i] + 23}">${esc(r.shareText)}</text>` : ""
      }</g>`;
    })
    .join("");
  return `<svg class="routes" viewBox="0 0 ${w} ${h}" role="group" aria-label="Which model takes which work"><circle class="cm-c" cx="${x0}" cy="${h / 2}" r="26"/><use href="#c-build" x="${x0 - 11}" y="${h / 2 - 11}" width="22" height="22"/><text class="rt-l" x="${x0}" y="${h / 2 + 46}" text-anchor="middle">Work</text>${paths}</svg>`;
}

// ---- The systems map ---------------------------------------------------------

// Boxes on a grid, each placed by its at: [column, row] in systems.json; a
// lane's label sits over its first row. Each box has a gauge of its use
// against its first limit, with a tick at the goal; arrows carry the handoff
// named in systems.json.
const SMAP = { col: 225, row: 94, laneGap: 36, top: 34, left: 20, box: [160, 74] };

// systems: systems.json entries, each with use { pct, status, text, tip };
// lanes: systems.json's lanes; goalPct: the tick. A handoff into a lower lane
// leaves from the box's bottom on a trunk above that lane, and one to another
// row leaves from the top or bottom, so its word sits on a horizontal run.
export function systemsMap(systems, selected, lanes = [], goalPct = 80) {
  const S = SMAP;
  const [bw, bh] = S.box;
  const starts = lanes.filter((l) => Number.isInteger(l.row)).sort((a, b) => a.row - b.row);
  const rowY = (r) => S.top + S.row * r + S.laneGap * starts.filter((l, i) => i > 0 && l.row <= r).length;
  const placed = systems.filter((x) => Array.isArray(x.at));
  if (!placed.length) return "";
  const at = Object.fromEntries(placed.map((x) => [x.id, [S.left + S.col * x.at[0], rowY(x.at[1])]]));
  const ctx = { at, bw, bh, cell: Object.fromEntries(placed.map((x) => [x.id, x.at])), laneOf: (id) => systems.find((x) => x.id === id)?.lane };
  const maxCol = Math.max(...placed.map((x) => x.at[0]));
  const maxRow = Math.max(...placed.map((x) => x.at[1]));
  const width = S.left * 2 + S.col * maxCol + bw + 5;
  const height = rowY(maxRow) + bh + 16;
  const edges = systems.flatMap((x) => (x.to ?? []).filter((to) => at[x.id] && at[to]).map((to) => sysEdge(x, to, ctx)));
  const boxes = systems.filter((x) => at[x.id]).map((x) => sysBox(x, at[x.id], { bw, bh, goalPct, selected })).join("");
  const labels = starts.map((l, i) => `<text class="sy-lane" x="${S.left}" y="${rowY(l.row) - (i ? 30 : 16)}">${esc(l.label)}</text>`).join("");
  const defs = `<defs><marker id="sy-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 8 4 0 8z" class="sy-head"/></marker></defs>`;
  return `<svg class="smap" viewBox="0 0 ${width} ${height}" role="group" aria-label="The systems, their use against their limits, and the handoffs">${defs}${labels}${edges.join("")}${boxes}</svg>`;
}

// One handoff arrow from system x to system id `to`, with its word on a horizontal run.
function sysEdge(x, to, { at, bw, bh, cell, laneOf }) {
  const [ax, ay] = at[x.id];
  const [bx, by] = at[to];
  const word = x.handoff?.[to] ?? "";
  if (laneOf(to) !== laneOf(x.id) && cell[to][1] > cell[x.id][1]) {
    // Down into a lower lane: a trunk over that lane's label, then a drop.
    const tx = ax + bw / 2;
    const ty = by - 22;
    return `<path class="sy-edge" d="M${tx} ${ay + bh}V${ty}H${bx + bw / 2}V${by - 4}" marker-end="url(#sy-arrow)"/>`;
  }
  const ty = by + bh / 2;
  const label = (mid) => (word ? `<text class="sy-w" x="${r1(mid)}" y="${ty - 6}">${esc(word)}</text>` : "");
  if (ay === by) {
    const [x1, x2] = [ax + bw, bx];
    return `<path class="sy-edge" d="M${x1} ${ty}H${x2 - 4}" marker-end="url(#sy-arrow)"/>${label((x1 + x2) / 2)}`;
  }
  const sx = ax + bw / 2;
  const sy = by < ay ? ay : ay + bh;
  return `<path class="sy-edge" d="M${sx} ${sy}V${ty}H${bx - 4}" marker-end="url(#sy-arrow)"/>${label((sx + bx) / 2)}`;
}

// One system's box: icon, name, use gauge against the goal tick, status and text.
function sysBox(x, [bx, by], { bw, bh, goalPct, selected }) {
  const u = x.use;
  const gw = bw - 24;
  const fill = finite(u.pct) ? Math.max(Math.min(u.pct, 100), 0) / 100 : null;
  const gauge = `<rect class="sy-track" x="${bx + 12}" y="${by + 44}" width="${gw}" height="8" rx="2"/>${
    fill !== null ? `<rect class="sy-fill s-${u.status}" x="${bx + 12}" y="${by + 44}" width="${r1(Math.max(gw * fill, 2))}" height="8" rx="2"/>` : ""
  }<path class="sy-tick" d="M${r1(bx + 12 + (gw * goalPct) / 100)} ${by + 40}v16"/>`;
  return `<a class="sy-node" href="#sy-${esc(x.id)}" data-sy="${esc(x.id)}"${x.id === selected ? ' aria-current="step"' : ""} aria-label="${esc(`${x.name}: ${u.tip}`)}" data-tip="${esc(u.tip)}"><rect class="sy-box" x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="8"/><use href="#c-${esc(x.icon)}" x="${bx + 10}" y="${by + 10}" width="16" height="16"/><text class="sy-n" x="${bx + 32}" y="${by + 23}">${esc(x.name)}</text>${gauge}${u.status ? `<use href="#g-${u.status}" x="${bx + 12}" y="${by + 58}" width="12" height="12"/>` : ""}<text class="sy-v" x="${bx + (u.status ? 28 : 12)}" y="${by + 68}">${esc(u.text)}</text></a>`;
}

// ---- The token flow ----------------------------------------------------------

// Nodes on a grid by their at: [column, row], inside group bands whose header
// carries the group's figures and its cache lifetime; one ring under every
// group for the plan they all draw on. Every number arrives as text with its
// tooltip, so this only places them.
const TFLOW = { left: 20, col: 250, box: [200, 56], top: 76, row: 76, ring: 30 };
const textW = (s) => String(s).length * 7.2;

// flow: { groups: [{ id, label, figs: [{ text, tip }], cache: { text, tip } }],
// nodes: [{ id, label, icon, group, at, tip, fig?: { text, tip } }],
// edges: [{ from, to, word, tip }], ring: { label, text, tip } }
export function tokenFlow(flow) {
  const T = TFLOW;
  const [bw, bh] = T.box;
  const nodes = flow.nodes.filter((n) => Array.isArray(n.at));
  if (!nodes.length) return "";
  const pos = Object.fromEntries(nodes.map((n) => [n.id, [T.left + T.col * n.at[0], T.top + T.row * n.at[1]]]));
  const maxCol = Math.max(...nodes.map((n) => n.at[0]));
  const maxRow = Math.max(...nodes.map((n) => n.at[1]));
  const bottom = T.top + T.row * maxRow + bh + 12;
  const width = T.left * 2 + T.col * maxCol + bw;
  const ringY = bottom + 16;
  const height = flow.ring ? ringY + T.ring + 4 : bottom + 4;
  const groups = flow.groups
    .map((g) => {
      const cols = nodes.filter((n) => n.group === g.id).map((n) => n.at[0]);
      if (!cols.length) return "";
      const gx = T.left + T.col * Math.min(...cols) - 10;
      const gw = T.col * (Math.max(...cols) - Math.min(...cols)) + bw + 20;
      const figs = g.figs.map((f, i) => `<g class="tf-fig" data-tip="${esc(f.tip)}" tabindex="0"><text x="${gx + 12}" y="${44 + 16 * i}">${esc(f.text)}</text></g>`).join("");
      const cx = gx + gw - 12;
      const cache = g.cache ? `<g class="tf-cache" data-tip="${esc(g.cache.tip)}" tabindex="0"><use href="#c-clock" x="${r1(cx - textW(g.cache.text) - 18)}" y="13" width="14" height="14"/><text x="${cx}" y="24">${esc(g.cache.text)}</text></g>` : "";
      const drop = flow.ring ? `<path class="tf-draw" d="M${r1(gx + gw / 2)} ${bottom}V${ringY - 3}" marker-end="url(#tf-arrow)"/>` : "";
      return `<rect class="tf-band" x="${gx}" y="4" width="${gw}" height="${bottom - 4}" rx="10"/><text class="tf-g" x="${gx + 12}" y="24">${esc(g.label)}</text>${figs}${cache}${drop}`;
    })
    .join("");
  const edges = flow.edges
    .filter((e) => pos[e.from] && pos[e.to])
    .map((e) => {
      const [ax, ay] = pos[e.from];
      const [bx, by] = pos[e.to];
      const ty = by + bh / 2;
      const sx = ay === by ? ax + bw : ax + bw / 2;
      const path = ay === by ? `M${sx} ${ty}H${bx - 4}` : `M${sx} ${ay + bh}V${ty}H${bx - 4}`;
      const word = e.word ? `<text class="tf-w" x="${r1((sx + bx) / 2)}" y="${ty - 6}">${esc(e.word)}</text>` : "";
      return `<g${e.tip ? ` data-tip="${esc(e.tip)}" tabindex="0"` : ""}><path class="tf-edge" d="${path}" marker-end="url(#tf-arrow)"/>${word}</g>`;
    })
    .join("");
  const boxes = nodes
    .map((n) => {
      const [x, y] = pos[n.id];
      const tip = [n.tip, n.fig?.tip].filter(Boolean).join("; ");
      return `<g class="tf-node"${tip ? ` data-tip="${esc(tip)}" tabindex="0"` : ""}><rect class="tf-box" x="${x}" y="${y}" width="${bw}" height="${bh}" rx="8"/><use href="#c-${esc(n.icon)}" x="${x + 10}" y="${y + 10}" width="16" height="16"/><text class="tf-n" x="${x + 32}" y="${y + 23}">${esc(n.label)}</text>${n.fig ? `<text class="tf-v" x="${x + 12}" y="${y + 44}">${esc(n.fig.text)}</text>` : ""}</g>`;
    })
    .join("");
  const ring = flow.ring
    ? `<g class="tf-ring" data-tip="${esc(flow.ring.tip)}" tabindex="0"><rect x="10" y="${ringY}" width="${width - 20}" height="${T.ring}" rx="15"/><text class="tf-n" x="26" y="${ringY + 20}">${esc(flow.ring.label)}</text><text class="tf-v" x="${width - 26}" y="${ringY + 20}" text-anchor="end">${esc(flow.ring.text)}</text></g>`
    : "";
  const defs = `<defs><marker id="tf-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 8 4 0 8z" class="tf-head"/></marker></defs>`;
  return `<svg class="tflow" viewBox="0 0 ${width} ${height}" role="group" aria-label="How work and tokens flow from the orchestrator to workers, subagents and workflows">${defs}${groups}${edges}${boxes}${ring}</svg>`;
}

// ---- When to delegate ----------------------------------------------------------

// One loop by default; the conditions that earn a subagent or session fan out
// from it, and lead to how to split. The lighter model hangs under the loop.
// Every node arrives resolved: { label, icon?, text, status, tip }.
const DMAP = { cols: [20, 260, 520, 790], top: 40, row: 76, box: [196, 58] };

function dnode(n, x, y) {
  const [bw, bh] = DMAP.box;
  const lx = n.icon ? x + 32 : x + 12;
  return `<g class="dm-node"${n.tip ? ` data-tip="${esc(n.tip)}" tabindex="0"` : ""}><rect class="dm-rect" x="${x}" y="${y}" width="${bw}" height="${bh}" rx="8"/>${n.icon ? `<use href="#c-${esc(n.icon)}" x="${x + 10}" y="${y + 10}" width="16" height="16"/>` : ""}<text class="dm-n" x="${lx}" y="${y + 23}">${esc(n.label)}</text>${
    n.status ? `<use href="#g-${esc(n.status)}" x="${x + 12}" y="${y + 34}" width="12" height="12"/>` : ""
  }<text class="dm-v" x="${x + (n.status ? 28 : 12)}" y="${y + 45}">${esc(n.text)}</text></g>`;
}

// d: { start, def, branches: [], how: [], light, when, then }
export function delegateMap(d) {
  const D = DMAP;
  const [bw, bh] = D.box;
  const [c0, c1, c2, c3] = D.cols;
  const y = (i) => D.top + D.row * i;
  const mid = (i) => y(i) + bh / 2;
  const rows = Math.max(d.branches.length, d.how.length, d.light ? 3 : 1);
  const height = y(rows - 1) + bh + 16;
  const width = c3 + bw + 20;
  const arrow = 'marker-end="url(#dm-arrow)"';
  const e = [];
  e.push(`<path class="dm-edge" d="M${c0 + bw} ${mid(0)}H${c1 - 4}" ${arrow}/>`);
  const s1 = c2 - 32;
  const last = d.branches.length - 1;
  if (d.branches.length) {
    e.push(`<path class="dm-edge" d="M${c1 + bw} ${mid(0)}H${s1}V${mid(last)}"/>`);
    d.branches.forEach((_, i) => e.push(`<path class="dm-edge" d="M${s1} ${mid(i)}H${c2 - 4}" ${arrow}/>`));
    e.push(`<text class="dm-w" x="${s1}" y="${D.top - 10}">${esc(d.when)}</text>`);
  }
  const s2 = c3 - 30;
  if (d.how.length && d.branches.length) {
    d.branches.forEach((_, i) => e.push(`<path class="dm-edge" d="M${c2 + bw} ${mid(i)}H${s2}"/>`));
    const hm = (mid(0) + mid(d.how.length - 1)) / 2;
    e.push(`<path class="dm-edge" d="M${s2} ${mid(0)}V${mid(last)}M${s2} ${r1(hm)}H${c3 - 4}" ${arrow}/>`);
  }
  if (d.light) {
    e.push(`<path class="dm-edge" d="M${c1 + bw / 2} ${y(0) + bh}V${y(2) - 4}" ${arrow}/>`);
    if (d.light.word) e.push(`<text class="dm-w l" x="${c1 + bw / 2 + 8}" y="${r1((y(0) + bh + y(2)) / 2 + 4)}">${esc(d.light.word)}</text>`);
  }
  const band = d.how.length
    ? `<rect class="dm-band" x="${c3 - 10}" y="${D.top - 14}" width="${bw + 20}" height="${y(d.how.length - 1) + bh + 24 - D.top}" rx="10"/><text class="dm-lane" x="${c3}" y="${D.top - 20}">${esc(d.then)}</text>`
    : "";
  const nodes = [
    dnode(d.start, c0, y(0)),
    dnode(d.def, c1, y(0)),
    ...d.branches.map((n, i) => dnode(n, c2, y(i))),
    ...d.how.map((n, i) => dnode(n, c3, y(i))),
    ...(d.light ? [dnode(d.light, c1, y(2))] : []),
  ].join("");
  const defs = `<defs><marker id="dm-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 8 4 0 8z" class="dm-head"/></marker></defs>`;
  return `<svg class="dmap" viewBox="0 0 ${width} ${height}" role="group" aria-label="When to delegate: one loop by default, the conditions for a subagent or session, and how to split">${defs}${band}${e.join("")}${nodes}</svg>`;
}
