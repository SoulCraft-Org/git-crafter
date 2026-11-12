// The Systems tab: what Claude hands work to, each against its limit. Drawn
// from systems.json and the repo's own data.

import { esc, finite, fmtCompact } from "../quality/render/charts.mjs";
import { cicon, systemsMap } from "./draw.mjs";
import { isMeasured } from "./model.mjs";
import { entryOf, mtile, srcTip, valueOf } from "./ui.mjs";

// One system's use against its first limit: percent, status by the 80% goal
// (past 100% misses), and the text and tooltip the map shows.
export function systemUse(x, m, goalPct) {
  const lim = x.limits?.[0];
  if (!x.usage?.metric) return { pct: null, status: "not-measured", text: "not measured", tip: `not measured: ${x.usage?.why ?? "no usage is read"}` };
  const e = m[x.usage.metric];
  if (!isMeasured(e)) return { pct: null, status: "not-measured", text: "not measured", tip: `not measured: ${e?.could_not_check ?? "no collector reported it"}` };
  if (!lim) return { pct: null, status: null, text: fmtCompact(e.value, e.unit), tip: srcTip(e) };
  const pct = (e.value / lim.value) * 100;
  const status = pct > 100 ? "misses" : pct >= goalPct ? "near" : "meets";
  return { pct, status, text: `${Math.round(pct * 10) / 10}% of ${fmtCompact(lim.value)} ${lim.unit}`, tip: `${e.label ?? x.usage.metric}: ${fmtCompact(e.value, e.unit)} of ${fmtCompact(lim.value)} ${lim.unit}; ${srcTip(e)}` };
}

function systemPanel(x, m, names, repoUrl) {
  const host = (u) => String(u).replace(/^https?:\/\//, "").split("/")[0];
  const limits = x.limits.length
    ? `<table class="lims"><tbody>${x.limits
        .map((l) => `<tr data-tip="${esc(`“${l.quote}”`)}" tabindex="0"><th scope="row">${esc(l.label)}</th><td class="num">${esc(`${fmtCompact(l.value)} ${l.unit}`)}</td><td><a href="${esc(l.source)}">${esc(host(l.source))}</a></td><td class="small">${esc(l.read)}</td></tr>`)
        .join("")}</tbody></table>`
    : "";
  const ids = [x.usage?.metric, ...(x.usage?.also ?? [])].filter(Boolean);
  const usage = ids.length ? `<div class="mts">${ids.map((id) => mtile(m[id], id)).join("")}</div>` : `<p class="reason">not measured: ${esc(x.usage?.why ?? "")}</p>`;
  const link = (list, word) => (list?.length ? `<p class="hand"><span class="small">${word}</span>${list.map((id) => `<a class="chip" href="#sy-${esc(id)}" data-sy="${esc(id)}">${esc(names[id] ?? id)}</a>`).join("")}</p>` : "");
  return `<div class="sypanel" id="sy-${esc(x.id)}" data-sy="${esc(x.id)}"><h3>${cicon(x.icon)}${esc(x.name)}</h3><p class="small">${esc(x.role)}</p>${limits}${usage}${link(x.from, "from")}${link(x.to, "to")}<p class="src"><a href="${esc(`${repoUrl}/${x.rule}`)}">${esc(x.rule)}</a> ${x.usage?.how ? esc(x.usage.how) : ""}</p></div>`;
}

// The Systems tab: each system's use against its limit, drawn as a map.
export function systemsTab(data, doc, repoUrl) {
  const m = new Proxy({}, { get: (_, id) => entryOf(data, id) });
  const goalPct = doc.usage_goal;
  // use is the computed figure; usage stays systems.json's own entry.
  const all = doc.systems.map((x) => ({ ...x, use: systemUse(x, m, goalPct) }));
  const names = Object.fromEntries(all.map((x) => [x.id, x.name]));
  const measured = all.filter((x) => finite(x.use.pct));
  const under = measured.length ? (measured.filter((x) => x.use.pct < goalPct).length / measured.length) * 100 : null;
  const past = measured.filter((x) => x.use.pct > 100).length;
  const at = new Date().toISOString();
  const none = "no system's use was measured against a limit";
  const measures = { under_goal: under, past_limit: measured.length ? past : null };
  const goalTile = (g) => {
    if (g.metric) return mtile({ ...(m[g.metric] ?? {}), label: g.label, target: g }, g.id);
    const value = measures[g.measure];
    return mtile(
      finite(value)
        ? { label: g.label, value, unit: g.unit, target: g, source: `systems.json: ${measured.length} of ${all.length} systems measured against a limit`, read_at: data.generated_at ?? at }
        : { label: g.label, could_not_check: g.measure in measures ? none : `systems.json names no measure "${g.measure}"`, target: g },
      g.id,
    );
  };
  const goals = `<div class="mts">${(doc.goals ?? []).map(goalTile).join("")}</div>`;
  const top = [...measured].sort((a, b) => b.use.pct - a.use.pct)[0]?.id ?? all[0]?.id;
  const map = systemsMap(all, top, doc.lanes, goalPct);
  const panels = all.map((x) => systemPanel(x, m, names, repoUrl)).join("");
  return `<section aria-label="Goals">${goals}</section>
<section class="hero sy-box" aria-label="Systems map"><div class="trail-box">${map}</div><p class="t-key small"><span>${esc(`tick: the ${goalPct}% goal`)}</span></p></section>
<section class="sypanels" aria-label="System detail">${panels}</section>
${modelsLane(doc.models, m)}
<p class="src"><a href="${esc(`${repoUrl}/systems.json`)}">systems.json</a></p>`;
}

// The Models lane: columns side by side on the same rows, each cell from
// systems.json's models: a metric, its complement, a sum, or a why.
export function modelsLane(models, m) {
  if (!models?.columns?.length) return "";
  const nm = (why) => `<td class="num nm" data-tip="${esc(`not measured: ${why}`)}" tabindex="0">–</td>`;
  const td = (e) => (isMeasured(e) ? `<td class="num" data-tip="${esc(srcTip(e))}" tabindex="0">${esc(valueOf(e))}</td>` : nm(e?.could_not_check ?? "no collector reads it"));
  const cell = (c) => {
    if (!c) return `<td class="num">–</td>`;
    if (c.why) return nm(c.why);
    if (c.sum) {
      const parts = c.sum.map((id) => [id, m[id]]);
      const got = parts.filter(([, e]) => isMeasured(e));
      if (!got.length) return nm(parts.map(([id, e]) => `${id}: ${e?.could_not_check ?? "no collector reported it"}`).join(" | "));
      const tip = parts.map(([id, e]) => `${e?.label ?? id}: ${isMeasured(e) ? `${valueOf(e)}; ${srcTip(e)}` : "not measured"}`).join(" | ");
      return `<td class="num" data-tip="${esc(tip)}" tabindex="0">${esc(valueOf({ ...got[0][1], value: got.reduce((a, [, e]) => a + e.value, 0) }))}</td>`;
    }
    const e = m[c.metric];
    return td(c.complement && isMeasured(e) ? { ...e, value: 100 - e.value } : e);
  };
  const head = models.columns.map((c) => `<th scope="col">${cicon(c.icon)}${esc(c.label)}</th>`).join("");
  const body = models.rows.map((r) => `<tr><th scope="row">${esc(r.label)}</th>${models.columns.map((c) => cell(r[c.id])).join("")}</tr>`).join("");
  return `<section aria-label="Models"><h3 class="ch">${cicon("tokens")}Models</h3><div class="scroll"><table class="mlane"><thead><tr><th scope="col"></th>${head}</tr></thead><tbody>${body}</tbody></table></div></section>`;
}
