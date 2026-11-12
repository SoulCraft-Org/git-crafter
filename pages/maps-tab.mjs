// The Maps tab: each of the repo's own process maps as a trail of steps, and
// one panel per step with its metric, its rule, its gates and its tools.

import { bars, bullet, esc, finite, fmtCompact, glyph, spark, stack, statusCounts, statusStack } from "../quality/render/charts.mjs";
import { historyFor } from "../quality/render/model.mjs";
import { ICON_IDS, cicon, trail } from "./draw.mjs";
import { grid } from "./draw-grid.mjs";
import { goalIndex, goalText, openingStep, stepReadout } from "./model.mjs";
import { atLeast, ideal, rateOf, repoBars, srcTip, when } from "./ui.mjs";

// A readout drawn once for the org and once per repo with its own value; the
// client shows the repo the filter picks, and dims a readout with no
// per-repo value.
function each(ro, draw) {
  const org = tagR(draw(ro.value, ro.status, ""), "");
  if (!ro.byRepo) return org;
  return org + Object.entries(ro.byRepo).map(([r, v]) => tagR(draw(v, ro.def ? rateOf(ro.def, v) : finite(v) ? null : "not-measured", r), r)).join("");
}
const tagR = (html, r) => html.replace(/^<(\w+)/, `<$1 data-r="${esc(r)}"${r ? " hidden" : ""}`);

function tile(kind, ro) {
  if (!ro) return `<div class="tile none"><p class="t-l">${kind}</p><p class="t-n">–</p><p class="t-m">not measured for this step</p></div>`;
  const ok = finite(ro.value);
  const status = ro.def ? ro.status : ok ? null : "not-measured";
  const num = each(ro, (v, st, r) => `<span class="t-nv">${st ? glyph(st) : ""}${esc(finite(v) ? `${atLeast(ro.entry, r)}${fmtCompact(v, ro.unit)}` : "–")}</span>`);
  return `<div class="tile${status ? ` s-${status}` : ""}" data-vg=""><p class="t-l">${kind}</p><p class="t-n">${num}</p><p class="t-m">${metricName(ro, ro.invert ? `100 less ${ro.label}` : ro.label)}</p>${
    ro.def ? `${each(ro, (v) => bullet(ro.def, finite(v) ? v : null))}<p class="goal">goal ${esc(goalText(ro.def, fmtCompact))}</p>` : ""
  }${ok ? "" : `<p class="reason">${esc(ro.entry?.could_not_check ?? "not measured")}</p>`}${ro.trend ?? ""}</div>`;
}

// A step's trend: one point a UTC day from the repo's Quality history runs,
// measured as the metric is defined now (historyFor). Drawn from 2 points;
// nothing with fewer, so one day never draws a flat line.
function stepTrend(history, ro) {
  if (!ro || !history?.length) return "";
  const points = historyFor(history, ro.def?.id === ro.id ? ro.def : ro.id, { by: "day" }).points;
  if (points.length < 2) return "";
  const first = points[0].label;
  const last = points.at(-1).label;
  const line = spark(points, { label: `${ro.label}, one read a day`, unit: ro.unit, width: 200, height: 40 });
  const tip = points.map((p) => `${p.label} ${fmtCompact(p.value, ro.unit)}`).join("; ");
  return `<figure class="t-trend" tabindex="0" data-tip="${esc(tip)}">${line}<figcaption class="small">${esc(`${points.length} days, ${first} to ${last}`)}</figcaption></figure>`;
}

// A metric's name links to the goal that rates it, when one does and a
// metrics page is built; otherwise it says where the number came from and when.
const metricName = (ro, text) =>
  ro.goalHref ? `<a href="${esc(ro.goalHref)}">${esc(text)}</a>` : `<span tabindex="0" data-tip="${esc(srcTip(ro.entry))}">${esc(text)}</span>`;


// A repo's pipeline lines that a step's gates_from names: its hooks or its deploys.
function pipelineLines(data, repos, pred) {
  const line = ({ r, d, src }) =>
    `<li data-repo="${esc(r)}" data-tip="${esc(`${d.file}; ${src.source}; read ${when(src.read_at)}`)}" tabindex="0"><b>${esc(r)}</b> ${esc(d.label)}: ${esc(d.runs)}${finite(d.value) ? ` <span class="small">${esc(`${d.value} min`)}${finite(d.pass_rate) ? `, ${esc(`${d.pass_rate}%`)} pass` : ""}</span>` : ""}</li>`;
  return repos.flatMap((r) => (data.pipelines?.[r]?.detail ?? []).filter(pred).map((d) => line({ r, d, src: data.pipelines[r] })));
}

// One line per repo that has workflow files, linking to its CI tab.
function workflowLines(data, repos) {
  const lines = [];
  for (const r of repos) {
    const p = data.pipelines?.[r];
    const n = new Set([...(p?.detail ?? []), ...(p?.apart ?? [])].filter((d) => d.kind === "workflow").map((d) => d.file)).size;
    if (n) lines.push(`<li data-repo="${esc(r)}"><a href="#tab=ci&amp;repo=${esc(r)}"><b>${esc(r)}</b> ${n} workflow${n === 1 ? "" : "s"}</a></li>`);
  }
  return lines;
}

const GATE_LINES = {
  hooks: (data, repos) => pipelineLines(data, repos, (d) => d.kind === "hook"),
  deploys: (data, repos) => pipelineLines(data, repos, (d) => d.stage === "deploy"),
  workflows: workflowLines,
};

// Gates a step passes through: the rules its map states, and what each
// repo's files say, as its gates_from names: its git hooks, its workflows or
// its deploys.
function gates(step, data, repos) {
  const rows = [...(step.gates ?? []).map((g) => `<li>${esc(g)}</li>`), ...(GATE_LINES[step.gates_from]?.(data, repos) ?? [])];
  return rows.length ? `<ul class="gates">${rows.join("")}</ul>` : "";
}

// Where a map's hours go: its time_bar metric's step hours as one labelled
// stacked bar (charts.mjs stack), the total rated by its goal, and each step
// the metric could not read named, never drawn as a zero.
function timeBar(m, data, opts) {
  if (!m.time_bar) return "";
  const ro = stepReadout({ metric: m.time_bar }, data.metrics, { ...opts, def: opts.defs?.[m.time_bar] ?? null });
  const e = ro.entry;
  const body = e?.detail?.length ? stack(e.detail, ro.unit, { labelled: true }) : `<p class="reason">${esc(e?.could_not_check ?? "not measured")}</p>`;
  const missing = (e?.missing ?? []).map((x) => `<li>${esc(`${x.label}: not read here; ${x.reason}`)}</li>`).join("");
  return `<figure class="time-bar" id="time-${esc(m.id)}"><figcaption>${timeBarHead(ro)}</figcaption>${body}${missing ? `<ul class="missing">${missing}</ul>` : ""}</figure>`;
}

// The time bar's caption: the metric's name, its total with its status, and
// its goal. An unscored total (a step missing) has no status mark.
function timeBarHead(ro) {
  const ok = finite(ro.value);
  const total = `${ok && ro.status ? glyph(ro.status) : ""}${esc(ok ? fmtCompact(ro.value, ro.unit) : "not scored")}`;
  const goal = ro.def ? `, goal ${esc(goalText(ro.def, fmtCompact))}` : "";
  return `<span tabindex="0" data-tip="${esc(srcTip(ro.entry))}">${esc(ro.label)}</span> ${total}${goal}`;
}

const KIND_NAMES = { quality: "Quality", speed: "Speed", consumption: "Consumption" };

function panel(map, step, i, ro, critical, cfg, data) {
  const key = `${map.id}-${step.id}`;
  const per = (ro2, title) => {
    const list = ro2 ? repoBars(ro2.entry, cfg.repos) : [];
    return list.some((d) => d.value !== 0) ? `<figure class="p-fig"><figcaption>${esc(title)}</figcaption>${bars(list, ro2.unit)}</figure>` : "";
  };
  // The step's one metric (checkMaps holds a step to exactly one).
  const figs = [per(ro, `${ro.label} by repo`)].filter(Boolean).join("");
  const ref = step.rule_ref;
  const icon = ICON_IDS.includes(step.icon ?? step.id) ? (step.icon ?? step.id) : "plan";
  return `<article class="panel" id="step-${esc(key)}" data-step="${esc(key)}" aria-labelledby="h-${esc(key)}">
<header class="p-head"><span class="p-num${critical.has(step.id) ? " crit" : ""}">${i + 1}</span><h3 id="h-${esc(key)}">${cicon(icon)}${esc(step.name)}</h3>${critical.has(step.id) ? '<span class="chip">critical path</span>' : ""}</header>
<div class="tiles">${tile(KIND_NAMES[ro.kind] ?? "Metric", ro)}</div>
<div class="p-body">
<div class="p-figs">${figs || '<p class="empty">No per-repo data for this step.</p>'}</div>
<div class="p-side">
<blockquote class="rule"><p>${esc(step.rule)}</p><a href="${esc(/^https:\/\//.test(ref) ? ref : `${cfg.repo_url}/${ref}`)}">${esc(step.rule_label ?? ref)}</a></blockquote>
${gates(step, data, cfg.repos)}
<ul class="tools">${step.tools.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
</div>
</div>
</article>`;
}

// The Maps tab: each of the repo's own process maps, one per category it
// needs, never another repo's. defs: the repo's Quality page definitions by
// id, which rate each step; null when the page could not read them. history:
// the Quality page's daily runs, oldest first, for each step's trend line.
export function mapsTab(data, goalsDoc, mapsDoc, defs, repos, metricsHref, history = []) {
  const maps = mapsDoc?.maps ?? [];
  if (!maps.length) return `<section class="hero flow"><p class="empty">This repo names no process maps yet. Its config's docs.maps names its own file, one map per category it needs; Git Crafter maps.json is the example.</p></section>`;
  const goals = goalIndex(goalsDoc);
  const cfg = { repo_url: mapsDoc.repo_url, repos };
  const readoutsByMap = {};
  const sections = maps.map((m) => {
    const critical = new Set(m.critical_path ?? m.steps.map((s) => s.id));
    const readouts = Object.fromEntries(m.steps.map((s) => [s.id, stepReadout(s, data.metrics, { def: defs?.[s.metric] ?? null, goals, ownRepo: data.own_repo ?? null })]));
    readoutsByMap[m.id] = readouts;
    for (const ro of Object.values(readouts)) {
      ro.goalHref = metricsHref && ro.goalId ? `${metricsHref}#goal-${ro.goalId}` : null;
      ro.trend = stepTrend(history, ro);
    }
    const selected = openingStep(m.steps, readouts);
    const steps = m.steps.map((s) => ({ ...s, short: s.short ?? s.name }));
    const stepbar = `<div class="stepbar" role="group" aria-label="${esc(m.name)} steps" hidden>${steps
      .map((s, i) => `<button type="button" data-step="${esc(`${m.id}-${s.id}`)}" aria-pressed="${s.id === selected}"><b>${i + 1}</b>${esc(s.short)}</button>`)
      .join("")}</div>`;
    return `<section class="map" id="map-${esc(m.id)}" data-map="${esc(m.id)}" aria-labelledby="h-map-${esc(m.id)}">
<header class="map-head"><h2 id="h-map-${esc(m.id)}">${esc(m.name)}</h2><p>${esc(m.why)}</p></header>
${ideal(`map-${m.id}`, m, m.name)}
<div class="hero flow"><div class="trail-box">${(steps.some((s) => s.at) ? grid : trail)({ ...m, steps }, readouts, critical, selected)}</div></div>
${timeBar(m, data, { defs, goals, ownRepo: data.own_repo ?? null })}
${stepbar}
<section class="panels">${m.steps.map((s, i) => panel(m, s, i, readouts[s.id], critical, cfg, data)).join("\n")}</section>
</section>`;
  });
  const legend = `<ul class="t-key"><li><svg viewBox="0 0 28 10" aria-hidden="true"><path class="k-main" d="M0 5h28"/></svg>critical path</li><li><svg viewBox="0 0 14 14" aria-hidden="true"><circle class="k-ring" cx="7" cy="7" r="5.5" pathLength="100" stroke-dasharray="70 100" transform="rotate(-90 7 7)"/></svg>ring: a share, fuller is better</li><li>Select a step for its detail</li></ul>`;
  // One tile per map: its name and a bar of its steps' statuses, linking to its section.
  const index = maps.map((m) => {
    const counts = statusCounts(m.steps.map((s) => ({ status: readoutsByMap[m.id][s.id]?.status ?? "not-measured" })));
    const label = `${m.name}: ${counts.meets} of ${m.steps.length} steps meet their goal`;
    return `<a href="#map-${esc(m.id)}" aria-label="${esc(label)}" data-tip="${esc(label)}"><b>${esc(m.name)}</b>${statusStack(counts, { legend: false, cls: "mi-bar" })}</a>`;
  });
  // A div, not a nav: the page's nav rule (quality/render/page.css) would pin it over the tab bar.
  return `<div class="map-index" role="navigation" aria-label="Maps">${index.join("")}</div>\n${legend}\n${sections.join("\n")}`;
}
