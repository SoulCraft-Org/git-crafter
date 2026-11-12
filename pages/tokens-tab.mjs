// The Tokens tab: what fills a request, how work flows, what moves each
// figure. Drawn from tokens.json and the repo's own data; labels only, every
// source, quote and read time a tooltip.

import { bullet, esc, finite, fmtCompact, glyph } from "../quality/render/charts.mjs";
import { cicon, tokenFlow } from "./draw.mjs";
import { goalText, isMeasured } from "./model.mjs";
import { entryOf, figText, figTip, idLabel, mtile, r1, rateOf, srcTip, valueOf } from "./ui.mjs";

// A top-level number of data/org.json as a figure.
function fieldFigure(fig, data) {
  const v = data[fig.field];
  return finite(v)
    ? { label: fig.label ?? idLabel(fig.field), value: v, unit: fig.unit ?? "", source: `data/org.json ${fig.field}, counted by the collector`, read_at: data.generated_at }
    : { label: fig.label, could_not_check: `data/org.json has no ${fig.field}`, source: "data/org.json" };
}

// The detail rows of a metric that match fig.row, summed.
function rowFigure(fig, e) {
  const re = new RegExp(fig.row, "i");
  const rows = (e.detail ?? []).filter((d) => re.test(d.label) && finite(d.value));
  if (!rows.length) return { label: e.label, could_not_check: `${fig.metric} has no row matching ${fig.row}`, source: e.source };
  return { label: `${e.label}: ${rows.map((d) => d.label).join(", ")}`, value: rows.reduce((a, d) => a + d.value, 0), unit: rows[0].unit ?? e.unit, source: e.source, read_at: e.read_at };
}

// One figure of tokens.json: a metric, one or more of its detail rows (summed),
// or a top-level number of data/org.json. Not measured says why.
export function figureOf(fig, data) {
  if (!fig) return undefined;
  if (fig.field) return fieldFigure(fig, data);
  const e = entryOf(data, fig.metric);
  if (!isMeasured(e)) return { label: e?.label ?? idLabel(fig.metric), could_not_check: e?.could_not_check ?? "no collector reported it", source: e?.source };
  return fig.row ? rowFigure(fig, e) : e;
}

// The goal that tokens.json sets from a systems.json limit: under its usage goal.
function limitGoal(g, e, systemsDoc) {
  const sys = systemsDoc?.systems?.find((x) => x.id === g.system);
  const lim = sys?.limits?.[g.limit ?? 0];
  const pct = systemsDoc?.usage_goal;
  if (!lim || !finite(pct)) return null;
  const goal_source = `systems.json: under ${pct}% of ${sys.name}'s ${lim.label}, ${fmtCompact(lim.value)} ${lim.unit}`;
  return g.percent
    ? { direction: "lower", goal: pct, near: 100, unit: "%", goal_source }
    : { direction: "lower", goal: (lim.value * pct) / 100, near: lim.value, unit: e?.unit ?? "", goal_source };
}

// The goal a figure is rated against: its own target, or tokens.json's goal
// for it, taken from systems.json's usage goal of a limit when it names one.
export function goalOf(fig, e, goals, systemsDoc) {
  if (!fig || fig.row) return null;
  if (e?.target && finite(e.target.goal)) return e.target;
  const g = (goals ?? []).find((x) => (fig.metric && x.metric === fig.metric) || (fig.field && x.field === fig.field));
  if (!g) return null;
  return g.system ? limitGoal(g, e, systemsDoc) : g;
}

// The layers of a request against its total: what is measured, what is left over, and each share.
function stackParts(stack, data) {
  const total = figureOf(stack.total, data);
  const layers = stack.layers.map((l) => ({ ...l, e: l.figure ? figureOf(l.figure, data) : { could_not_check: l.why } }));
  const measured = layers.filter((l) => isMeasured(l.e));
  const sum = measured.reduce((a, l) => a + l.e.value, 0);
  const ok = isMeasured(total) && total.value >= sum;
  const rest = ok ? total.value - sum : null;
  const share = (v) => (ok && total.value > 0 ? `${Math.round((v / total.value) * 1000) / 10}%` : "");
  const names = layers.filter((l) => !isMeasured(l.e)).map((l) => l.label).join(", ");
  const restTip = `${stack.rest_label ?? "not measured apart"}: ${names}${finite(rest) ? `; ${fmtCompact(rest, total.unit)}, ${share(rest)} of the call` : ""}`;
  return { total, layers, measured, ok, rest, share, restTip };
}

// The call as one bar of its measured layers and the rest, or why it cannot be drawn.
function stackBar({ total, measured, ok, rest, share, restTip }) {
  if (!ok) return `<p class="reason">${esc(`not measured: ${isMeasured(total) ? "the measured layers exceed the call" : (total?.could_not_check ?? "no collector reported the call's size")}`)}</p>`;
  const spans = measured
    .map((l, i) => `<span class="p${i + 1}" style="flex-grow:${r1((l.e.value / total.value) * 1000)}" data-tip="${esc(`${l.label}: ${valueOf(l.e)}, ${share(l.e.value)}`)}"></span>`)
    .join("");
  const tail = rest > 0 ? `<span class="rest" style="flex-grow:${r1((rest / total.value) * 1000)}" data-tip="${esc(restTip)}"></span>` : "";
  return `<span class="pbar tstack" role="img" aria-label="${esc(`${measured.map((l) => `${l.label} ${share(l.e.value)}`).join(", ")}, ${restTip}`)}">${spans}${tail}</span>`;
}

function stackRows({ layers, share }) {
  let n = 0;
  return layers
    .map((l) => {
      const m = isMeasured(l.e);
      const sw = m ? `<i class="p${++n}"></i>` : `<i class="rest"></i>`;
      const tip = `${l.loads}; ${m ? srcTip(l.e) : `not measured apart: ${l.why ?? l.e?.could_not_check}`}`;
      return `<tr data-tip="${esc(tip)}" tabindex="0"><td class="sw">${sw}</td><th scope="row"><a href="${esc(l.source)}">${esc(l.label)}</a></th><td class="num">${m ? esc(valueOf(l.e)) : "–"}</td><td class="num share">${m ? share(l.e.value) : ""}</td></tr>`;
    })
    .join("");
}

function requestStack(stack, data) {
  const parts = stackParts(stack, data);
  const { total } = parts;
  const def = total?.target && finite(total.target.goal) ? total.target : null;
  const status = def ? rateOf(def, isMeasured(total) ? total.value : null) : null;
  const head = `<p class="ts-total" data-tip="${esc(figTip(total))}${def ? esc(`; goal ${goalText(def, fmtCompact)}`) : ""}" tabindex="0">${status ? glyph(status) : ""}<b>${esc(figText(total))}</b> <span class="small">${esc(stack.total.suffix ?? "")}</span></p>`;
  return `<section class="hero" aria-label="${esc(stack.label)}"><h3 class="ch">${cicon("tokens")}${esc(stack.label)}</h3>${head}${stackBar(parts)}<table class="parts tparts"><tbody>${stackRows(parts)}</tbody></table></section>`;
}

// The flow drawing's groups, nodes, edges and ring, each figure read from the data.
function flowOf(f, data) {
  const cell = (x) => {
    const e = figureOf(x, data);
    return { text: figText(e, x.suffix), tip: figTip(e) };
  };
  return {
    groups: f.groups.map((g) => ({
      ...g,
      figs: (g.figures ?? []).map(cell),
      cache: g.cache ? { text: `cache ${g.cache.ttl}`, tip: `“${g.cache.quote}” ${g.cache.source}` } : null,
    })),
    nodes: f.nodes.map((n) => ({ ...n, fig: n.figure ? cell(n.figure) : null })),
    edges: f.edges,
    ring: f.ring ? { label: f.ring.label, text: "not measured", tip: `not measured: ${f.ring.why}; ${f.ring.source}` } : null,
  };
}

const cacheLayers = (f) =>
  `<ol class="clayers" aria-label="Cache layers, in prefix order">${(f.cache_layers ?? []).map((l) => `<li data-tip="${esc(`holds ${l.holds}; changes when ${l.breaks}`)}" tabindex="0">${esc(l.label)}</li>`).join("")}</ol>`;

// The Now cell of a practice row: its figure against its goal, or that no metric exists yet.
function nowCell(p, e, def) {
  if (!e) return `<td class="num nm" data-tip="${esc(`no metric yet: no collector measures ${p.moves}`)}" tabindex="0">no metric yet</td>`;
  const ok = isMeasured(e);
  const status = def ? rateOf(def, ok ? e.value : null) : ok ? null : "not-measured";
  const tip = `${figTip(e)}${def?.goal_source ? `; goal: ${def.goal_source}` : ""}`;
  return `<td class="num${ok ? "" : " nm"}" data-tip="${esc(tip)}" tabindex="0">${status ? glyph(status) : ""}${esc(ok ? valueOf(e) : "not measured")}</td>`;
}

const goalCell = (def, e) => (def ? `<td class="tg">${bullet(def, isMeasured(e) ? e.value : null)}<span class="small">${esc(goalText(def, fmtCompact))}</span></td>` : `<td class="tg"></td>`);

function practiceRow(p, data, doc, systemsDoc) {
  const e = p.figure ? figureOf(p.figure, data) : null;
  const def = e ? goalOf(p.figure, e, doc.goals, systemsDoc) : null;
  return `<tr><th scope="row"><a href="${esc(p.doc)}"${p.tip ? ` data-tip="${esc(p.tip)}"` : ""}>${esc(p.label)}</a></th><td class="small">${esc(p.moves)}</td>${nowCell(p, e, def)}${goalCell(def, e)}</tr>`;
}

// One practice group's table, or nothing when no practice belongs to it.
function practicesTable(g, data, doc, systemsDoc) {
  const rows = doc.practices
    .filter((p) => p.group === g.id)
    .map((p) => practiceRow(p, data, doc, systemsDoc))
    .join("");
  return rows ? `<section aria-label="${esc(g.label)} practices"><h3 class="ch">${cicon(g.icon)}${esc(g.label)}</h3><div class="scroll"><table class="practices"><thead><tr><th scope="col">Practice</th><th scope="col">Moves</th><th scope="col">Now</th><th scope="col">Goal</th></tr></thead><tbody>${rows}</tbody></table></div></section>` : "";
}

// The Tokens tab: the token-flow figures, the flow drawing and its tiles.
export function tokensTab(data, doc, systemsDoc, repoUrl) {
  const f = doc.flow;
  const c = f.compaction;
  const tiles = `<div class="mts">${(f.figures ?? []).map((x) => mtile(figureOf(x, data), x.metric ?? x.field)).join("")}${
    c ? mtile({ label: c.label, value: c.value, unit: c.unit, source: `${c.source}: “${c.quote}”` }, "compaction") : ""
  }</div>`;
  return `${requestStack(doc.stack, data)}
<section class="hero tf-box" aria-label="Flow"><h3 class="ch">${cicon("sessions")}Flow</h3><div class="trail-box">${tokenFlow(flowOf(f, data))}</div></section>
<section aria-label="Cache and compaction"><h3 class="ch">${cicon("clock")}Cache</h3><p class="src"><a href="${esc(f.cache_source)}">prompt caching</a></p>${cacheLayers(f)}${tiles}</section>
${(doc.groups ?? []).map((g) => practicesTable(g, data, doc, systemsDoc)).join("\n")}
<p class="src"><a href="${esc(`${repoUrl}/tokens.json`)}">tokens.json</a></p>`;
}
