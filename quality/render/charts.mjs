// Pure drawing functions for the Quality and Speed page (orchestrator design
// spec, 2026-11-02). Each takes numbers and labels and returns an SVG or HTML
// string; none reads a file or a global. page.mjs lays them out, page.css
// colors them from the site tokens, and charts.test.mjs pins the geometry.

// Escapes text for HTML, attributes included.
export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// True for a finite number.
export const finite = (v) => typeof v === "number" && Number.isFinite(v);

// A number as text, rounded for its size, with its unit.
export function fmt(value, unit = "") {
  const abs = Math.abs(value);
  const n = abs >= 100 ? Math.round(value).toLocaleString("en-US") : String(Math.round(value * 100) / 100);
  if (!unit) return n;
  return unit === "%" ? `${n}%` : `${n} ${unit}`;
}

// Large values compact (519K, 34.1M) where a row gives them one line; the
// expanded row keeps the exact figure.
export function fmtCompact(value, unit = "") {
  const abs = Math.abs(value);
  if (abs < 100_000) return fmt(value, unit);
  const [div, suffix, digits] = abs >= 1e9 ? [1e9, "B", 1] : abs >= 1e6 ? [1e6, "M", 1] : [1e3, "K", 0];
  const n = `${(value / div).toFixed(digits).replace(/\.0$/, "")}${suffix}`;
  if (!unit) return n;
  return unit === "%" ? `${n}%` : `${n} ${unit}`;
}

// A share of a whole as a whole percent; under 1% reads "<1%", not "0%".
export function sharePct(f) {
  if (!finite(f)) return "–";
  const p = f * 100;
  return p > 0 && p < 1 ? "<1%" : `${Math.round(p)}%`;
}

const pct = (f) => `${(Math.min(Math.max(finite(f) ? f : 0, 0), 1) * 100).toFixed(1)}%`;
const r1 = (n) => String(Math.round(n * 10) / 10);

// A metric's status comes from score.mjs. A 0 to 100 score reads the same way
// as a metric: 80 or more meets, 50 to 79 is near, under 50 misses.
const STATUS_ORDER = ["meets", "near", "misses", "not-measured"];
export const STATUS_WORD = { meets: "meets goal", near: "near goal", misses: "misses goal", "not-measured": "not measured" };
const COUNT_WORD = { meets: "meet", near: "near", misses: "miss", "not-measured": "not measured" };
// The status a 0 to 100 score earns: meets at 80, near at 50.
export const scoreStatus = (score) => (!finite(score) ? "not-measured" : score >= 80 ? "meets" : score >= 50 ? "near" : "misses");

// A status glyph from the sprite in icons.mjs. An empty label marks it
// decorative, for places where the status word is already text beside it.
export const glyph = (status, label = STATUS_WORD[status]) =>
  `<svg class="g" ${label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true"'}><use href="#g-${status}"/></svg>`;

// A 0 to 100 track with zones for under 50, 50 to 79 and 80 up, the score as
// a solid bar, and ticks at 50 and 80. One span; page.css draws it from --v.
export function meter(score, label) {
  if (!finite(score)) return `<span class="meter" role="img" aria-label="${esc(label)}: not measured"></span>`;
  const v = Math.min(Math.max(score, 0), 100);
  return `<span class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${v}" aria-label="${esc(label)}" style="--v:${v}%"></span>`;
}

// Bullet graph (Stephen Few): status zones laid out by direction, the value
// as a dark bar, the goal as a tick. The scale ends at 100 for a percent,
// otherwise past the largest of goal, near and value.
export function bulletScale(def, value) {
  if (def.unit === "%") return 100;
  const m = Math.max(def.goal * 1.25, def.near * 1.25, finite(value) ? value * 1.05 : 0);
  return m > 0 ? m : 1;
}

// The bullet's three status zones, [class, from, to], laid out by direction.
export function bulletZones(def, max) {
  const c = (x) => Math.min(Math.max(x, 0), max);
  const [goal, near] = [c(def.goal), c(def.near)];
  return def.direction === "higher"
    ? [["misses", 0, near], ["near", near, goal], ["meets", goal, max]]
    : [["meets", 0, goal], ["near", goal, near], ["misses", near, max]];
}

// One span per bullet: page.css draws the zones, the value bar and the goal
// tick from four percentages. Inline SVG cost about 330 bytes a row and put
// the page near its budget, then 700 KB.
const pctOf = (v, max) => `${r1((Math.min(Math.max(v, 0), max) / max) * 100)}%`;
// The bullet graph for value against def.
export function bullet(def, value) {
  const max = bulletScale(def, value);
  const [first, second] = bulletZones(def, max);
  const vars = [`--a:${pctOf(first[2], max)}`, `--b:${pctOf(second[2], max)}`, `--g:${pctOf(def.goal, max)}`];
  const cls = [def.direction === "higher" ? "hi" : "lo"];
  // Past the scale (a percent over 100) the bar stops short of an arrow cap.
  const over = finite(value) && value > max;
  if (!finite(value)) cls.push("nv");
  else if (over) cls.push("over");
  else vars.push(`--v:${pctOf(value, max)}`);
  return `<span class="bl ${cls.join(" ")}" style="${vars.join(";")}" aria-hidden="true">${over ? "<i></i>" : ""}</span>`;
}

// One 100% bar of metric counts by status, with the counts in a legend
// beneath, so no segment has to fit its own label.
export function statusCounts(rows) {
  const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0]));
  for (const r of rows) counts[r.status] += 1;
  return counts;
}

// The counts from statusCounts as one 100% bar, with a legend by default.
export function statusStack(counts, { legend = true, cls = "" } = {}) {
  const words = STATUS_ORDER.filter((s) => counts[s]).map((s) => `${counts[s]} ${COUNT_WORD[s]}`).join(", ");
  const segs = STATUS_ORDER.filter((s) => counts[s] > 0)
    .map((s) => `<span class="b-${s}" style="flex-grow:${counts[s]}"></span>`)
    .join("");
  const bar = `<span class="sbar${cls ? ` ${cls}` : ""}" role="img" aria-label="${esc(words || "no metrics")}"${words ? ` data-tip="${esc(words)}"` : ""}>${segs}</span>`;
  if (!legend) return bar;
  const keys = STATUS_ORDER.map((s) => `<span class="sk">${glyph(s, "")}<b>${counts[s] ?? 0}</b> ${COUNT_WORD[s]}</span>`).join("");
  return `${bar}<span class="slegend">${keys}</span>`;
}

// "site/src/lib/seats/viz.ts:168 frontRangeMap" splits into its directory and
// the part a reader looks for. Page paths ("/regions/") and plain labels stay
// whole.
export function splitPath(label) {
  const m = /^((?:[\w@.+-]+\/)+)([^/]+)$/.exec(String(label ?? ""));
  return m ? { dir: m[1], base: m[2] } : null;
}

function labelCell(label) {
  const p = splitPath(label);
  if (!p) return `<th scope="row">${esc(label)}</th>`;
  // The left-to-right marks keep the trailing slash in place inside the
  // right-to-left box that ellipsizes the directory from its start. The
  // client script gives the cell the whole path as its tooltip.
  return `<th scope="row"><span class="base">${esc(p.base)}</span><span class="dir">&lrm;${esc(p.dir)}&lrm;</span></th>`;
}

const MAX_ROWS = 12;
const trimmed = (detail) => (detail.length > MAX_ROWS ? `<p class="trim">${MAX_ROWS} of ${detail.length} shown</p>` : "");
const itemValue = (d, unit) => (finite(d.value) ? fmt(d.value, d.unit ?? unit) : "–");

// A breakdown item may carry its own unit (detail[].unit), because a
// breakdown often counts something other than the headline: "lines added"
// under a lines-per-hour metric. Without one it takes the metric's unit.
export function bars(detail, unit, { plain = false } = {}) {
  const rows = detail.slice(0, MAX_ROWS);
  const max = Math.max(...rows.map((d) => (finite(d.value) ? d.value : 0)), 0) || 1;
  return `<table class="bars${plain ? " plain" : ""}"><tbody>${rows
    .map(
      (d) =>
        `<tr>${labelCell(d.label)}${plain ? "" : `<td class="bar"><span style="width:${pct(d.value / max)}"></span></td>`}<td class="num">${esc(itemValue(d, unit))}</td></tr>`,
    )
    .join("")}</tbody></table>${trimmed(detail)}`;
}

// Ordered stages, largest first: bars shrink in order, each with its count
// and its share of the first stage.
export function funnel(detail, unit) {
  const rows = detail.slice(0, MAX_ROWS);
  const first = rows[0]?.value;
  const base = finite(first) && first > 0 ? first : null;
  const scale = base ?? (Math.max(...rows.map((d) => (finite(d.value) ? d.value : 0)), 0) || 1);
  return `<table class="bars funnel"><tbody>${rows
    .map(
      (d) =>
        `<tr>${labelCell(d.label)}<td class="bar"><span style="width:${pct(d.value / scale)}"></span></td><td class="num">${esc(itemValue(d, unit))}</td><td class="num share">${base ? sharePct(d.value / base) : "–"}</td></tr>`,
    )
    .join("")}</tbody></table>${trimmed(detail)}`;
}

const MAX_PARTS = 5;
const partClass = (d, i) => `p${Number.isInteger(d.part) && d.part >= 1 && d.part <= MAX_PARTS ? d.part : i + 1}`;
// Parts of one whole, at most 5; a longer tail folds into "Other". The part
// colors are a validated categorical set (page.css), and every value and
// share is also text in the legend rows. labelled: each part also carries its
// label and value under it, in text color, cut short where a part is narrow.
// A row's part (1 to 5) fixes its color, so a step keeps its color when
// another step is missing.
export function stack(detail, unit, { labelled = false } = {}) {
  let parts = detail.filter((d) => finite(d.value) && d.value >= 0);
  if (parts.length > MAX_PARTS) {
    const rest = parts.slice(MAX_PARTS - 1);
    const units = new Set(rest.map((d) => d.unit));
    parts = [...parts.slice(0, MAX_PARTS - 1), { label: "Other", value: rest.reduce((n, d) => n + d.value, 0), unit: units.size === 1 ? rest[0].unit : undefined }];
  }
  const total = parts.reduce((n, d) => n + d.value, 0);
  const share = (v) => (total > 0 ? sharePct(v / total) : "–");
  const words = parts.map((d) => `${d.label} ${share(d.value)}`).join(", ");
  const part = (d, i) => {
    const attrs = `style="flex-grow:${r1((d.value / total) * 1000)}" data-tip="${esc(`${d.label}: ${share(d.value)}`)}"`;
    return labelled ? `<span ${attrs}><i class="${partClass(d, i)}"></i><b>${esc(`${d.label} ${itemValue(d, unit)}`)}</b></span>` : `<span class="${partClass(d, i)}" ${attrs}></span>`;
  };
  const bar = total > 0 ? `<span class="pbar${labelled ? " lab" : ""}" role="img" aria-label="${esc(words)}">${parts.map((d, i) => (d.value > 0 ? part(d, i) : "")).join("")}</span>` : "";
  return `${bar}<table class="parts"><tbody>${parts
    .map(
      (d, i) =>
        `<tr><td class="sw"><i class="${partClass(d, i)}"></i></td>${labelCell(d.label)}<td class="num">${esc(itemValue(d, unit))}</td><td class="num share">${share(d.value)}</td></tr>`,
    )
    .join("")}</tbody></table>`;
}

// A 2 px line with the last point marked. A partial last point (this week so
// far) is hollow and joined by a lighter segment. The current value is
// labeled once, at the end.
export function spark(points, { label = "", unit = "", width = 120, height = 34, endLabel = true } = {}) {
  const pts = points.filter((p) => finite(p.value));
  if (pts.length < 2) return "";
  const vals = pts.map((p) => p.value);
  const min = Math.min(...vals);
  const span = Math.max(...vals) - min || 1;
  const [padX, padTop, padBottom] = [5, endLabel ? 18 : 6, 6];
  const step = (width - padX * 2) / (pts.length - 1);
  const xy = pts.map((p, i) => [padX + i * step, height - padBottom - ((p.value - min) / span) * (height - padTop - padBottom)]);
  const last = pts.length - 1;
  const partial = pts[last].partial === true;
  const line = (list) => list.map(([x, y]) => `${r1(x)},${r1(y)}`).join(" ");
  const [lx, ly] = xy[last];
  const words = pts.map((p) => `${p.label} ${fmt(p.value, p.unit ?? unit)}${p.partial ? " so far" : ""}`).join(", ");
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(`${label}: ${words}`)}"><polyline points="${line(partial ? xy.slice(0, last) : xy)}"/>${
    partial ? `<polyline class="tail" points="${line(xy.slice(last - 1))}"/>` : ""
  }<circle class="dot${partial ? " hollow" : ""}" cx="${r1(lx)}" cy="${r1(ly)}" r="4"/>${
    endLabel ? `<text x="${r1(lx)}" y="${r1(ly - 8)}" text-anchor="end">${esc(fmt(pts[last].value, pts[last].unit ?? unit))}</text>` : ""
  }</svg>`;
}

// Item scores 1 to 5 as five columns, in the review ramp's colors. Bars are
// sized in pixels (44 at most) so the count above and score below always fit.
export function histogram(counts) {
  const max = Math.max(...counts, 1);
  return `<span class="hist" role="img" aria-label="${esc(counts.map((n, i) => `score ${i + 1}: ${n}`).join(", "))}">${counts
    .map((n, i) => `<span class="hc"><b>${n}</b><span class="hb k${i + 1}" style="height:${n > 0 ? Math.max(Math.round((n / max) * 44), 2) : 0}px"></span><i>${i + 1}</i></span>`)
    .join("")}</span>`;
}

// ---- The range: each tab a massif, the snowline the goal ----------------

// One peak: a triangle with a fixed base, so its area grows with the score,
// white above the 80 line. A score that could not be measured is a low stone
// mound.
function peak(cx, score, cls, g) {
  if (!finite(score)) {
    return `<path class="r-mound" d="M${r1(cx - g.half)} ${g.base}Q${r1(cx)} ${r1(g.base - g.mound * 2)} ${r1(cx + g.half)} ${g.base}Z"/>`;
  }
  const s = Math.min(Math.max(score, 0), 100);
  const top = g.base - s * g.k;
  let out = `<path class="${cls}" d="M${r1(cx - g.half)} ${g.base}L${r1(cx)} ${r1(top)}L${r1(cx + g.half)} ${g.base}Z"/>`;
  if (s > 80) {
    const hw = (g.half * (s - 80)) / s;
    const y80 = g.base - 80 * g.k;
    out += `<path class="r-snow" d="M${r1(cx - hw)} ${r1(y80)}L${r1(cx)} ${r1(top)}L${r1(cx + hw)} ${r1(y80)}Z"/>`;
  }
  return out;
}

// The range is 1200 units of massifs plus a 40-unit gutter for the 80 and 50
// labels. Each massif's slot is 100 wide, or narrower when more tabs share
// the 1200, down to 92, the narrowest slot whose labels stay clear; past 13
// tabs the range grows wider instead. Peaks and labels scale with the slot.
export const RANGE = { plot: 1200, gutter: 40, height: 330, base: 280, k: 2.2, mound: 11, maxSlot: 100, minSlot: 92 };
// The width of each massif's slot when n tabs share the range.
const rangeSlot = (n) => Math.max(RANGE.minSlot, Math.min(RANGE.maxSlot, Math.floor(RANGE.plot / Math.max(n, 1))));

// A summit's label: its status glyph and score, set outward from the summit
// (Quality to the left, Speed to the right). Ten units out keeps a "100"
// clear of the other summit's label and of the neighbor's down to a 92 slot.
const LABEL_OUT = 10;
// A score as the range draws it: rounded, or a dash for not measured.
const numText = (score) => (finite(score) ? String(Math.round(score)) : "–");
function summitLabel(cx, score, side) {
  const R = RANGE;
  const text = numText(score);
  const y = (finite(score) ? R.base - Math.min(Math.max(score, 0), 100) * R.k : R.base - R.mound) - 9;
  const tw = text.length * 10.2;
  const [gw, gap] = [12, 2];
  const left = side < 0 ? cx + LABEL_OUT - tw - gap - gw : cx - LABEL_OUT;
  return `<use href="#g-${scoreStatus(score)}" x="${r1(left)}" y="${r1(y - 11.5)}" width="${gw}" height="${gw}"/><text class="r-num" x="${r1(left + gw + gap)}" y="${r1(y)}">${text}</text>`;
}

const scoreWords = (p) => (finite(p.score) ? `${p.score}, ${p.measured} of ${p.total} measured` : `not measured, 0 of ${p.total}`);
// A table that scrolls sideways on a phone: the box takes keyboard focus and has a name, so the scroll works without a mouse.
export const scrollBox = (name, inner) => `<div class="scroll" tabindex="0" role="group" aria-label="${esc(name)}">${inner}</div>`;

// An accessible name starts with the text a reader sees (WCAG 2.5.3), then
// adds the full name when the visible one is short: "Docs (Documentation)".
export const labelFirst = (shown, full) => (full && full !== shown ? `${shown} (${full})` : shown);
// A massif's tooltip: its name and both scores in words.
const massifTip = (t) => `${labelFirst(t.short, t.name)}: quality ${scoreWords(t.quality)}; speed ${scoreWords(t.speed)}`;

// tabs: [{ id, name, short, icon, quality: { score, measured, total }, speed }]
export function range(tabs) {
  const R = RANGE;
  const slot = rangeSlot(tabs.length);
  const g = { base: R.base, k: R.k, half: slot * 0.26, mound: R.mound };
  const plot = slot * tabs.length;
  const width = plot + R.gutter;
  const y = (s) => R.base - s * R.k;
  const massifs = tabs
    .map((t, i) => {
      const x0 = i * slot;
      const [q, s, mid] = [x0 + slot * 0.38, x0 + slot * 0.62, x0 + slot / 2];
      const tip = massifTip(t);
      return `<a class="massif" href="#${esc(t.id)}" aria-label="${esc(`${t.short} ${numText(t.quality.score)} ${numText(t.speed.score)}. ${tip}`)}" data-tip="${esc(tip)}" style="--i:${i}"><text class="r-name" x="${r1(mid)}" y="324">${esc(t.short)}</text> <rect class="hit" x="${r1(x0 + 2)}" y="16" width="${slot - 4}" height="${R.height - 18}" rx="6"/><g class="peaks">${peak(s, t.speed.score, "r-s", g)}${peak(q, t.quality.score, "r-q", g)}</g><g class="nums">${summitLabel(q, t.quality.score, -1)} ${summitLabel(s, t.speed.score, 1)}</g><use class="r-ic" href="#i-${esc(t.icon ?? t.id)}" x="${r1(mid - 8)}" y="289" width="16" height="16"/></a>`;
    })
    .join("");
  return `<svg class="range" viewBox="0 0 ${width} ${R.height}" role="group" aria-label="Quality and speed by tab"><path class="r-line" d="M0 ${y(80)}H${plot}M0 ${y(50)}H${plot}"/><path class="r-base" d="M0 ${R.base}H${plot}"/><text class="r-lab" x="${width - 4}" y="${y(80) + 4}">80</text><text class="r-lab" x="${width - 4}" y="${y(50) + 4}">50</text>${massifs}</svg>`;
}

// The same drawing for one tab, in its header.
export function miniMassif(quality, speed) {
  const g = { base: 74, k: 0.6, half: 20, mound: 5 };
  const y80 = g.base - 80 * g.k;
  return `<svg class="mini" viewBox="0 0 120 80" width="120" height="80" aria-hidden="true" focusable="false"><path class="r-line" d="M4 ${y80}H116"/><path class="r-base" d="M4 ${g.base}H116"/>${peak(70, speed?.score, "r-s", g)}${peak(50, quality?.score, "r-q", g)}</svg>`;
}
