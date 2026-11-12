// What the Process and Metrics tabs share: number and time text, the status a
// goal gives a value, and the tile that shows one metric. Pure functions of
// the model's data; each returns an HTML string or a plain value.

import { bars, bullet, esc, finite, fmtCompact, glyph, spark } from "../quality/render/charts.mjs";
import { idealBlock } from "../quality/render/page.mjs";
import { isMeasured, rate } from "./model.mjs";

// A value known only as a lower bound (the org's when e.bound, a repo's when
// e.bound_repos names it) reads "≥ x".
export const atLeast = (e, r = "") => ((r ? e?.bound_repos?.includes(r) : e?.bound) ? "≥ " : "");
// A metric's value as text in unit (its own by default), or a dash.
export const val = (e, unit) => (isMeasured(e) ? `${atLeast(e)}${fmtCompact(e.value, unit ?? e.unit ?? "")}` : "–");
// An ISO time as "YYYY-MM-DD HH:MM UTC".
export const when = (iso) => (iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "");
// A metric's by_repo values as bars, largest first.
export const repoBars = (e, repos) =>
  repos
    .map((r) => ({ label: r, value: e?.by_repo?.[r] }))
    .filter((d) => finite(d.value))
    .sort((a, b) => b.value - a.value);
// A repo's GitHub URL.
export const ghRepo = (org, r) => `https://github.com/${org}/${r}`;
// Where a number came from and when, for a metric no Git Crafter goal rates.
export const srcTip = (e) => [e?.source, e?.read_at ? `read ${when(e.read_at)}` : ""].filter(Boolean).join("; ");

// The status a value earns against a goal definition: meets, near or misses.
export const rateOf = (def, v) => rate(def, v).status;

// A metric's value as text in its own unit, or a dash.
export const valueOf = (e) => val(e);
// The read error behind a site metric the collector could not copy, so a
// missing id still says why it is not measured.
export const siteError = (data) => data.errors?.find((x) => x.startsWith("site quality data"));
// The metric's entry; a claude. or site. id the collector could not copy
// gets a could_not_check saying why.
export function entryOf(data, id) {
  const e = data.metrics?.[id];
  if (e) return e;
  const err = siteError(data);
  return /^(claude|site)\./.test(id) && err ? { could_not_check: `could not read the site's data: ${err}`, source: `${data.site?.repo ?? "the Quality data's repo"} quality/data/local.json` } : undefined;
}
// A label for a metric with none: "claude.context_per_call" reads "context per call".
export const idLabel = (id) => String(id).split(".").pop().replace(/_/g, " ");
const WEEK = /^\d{4}-\d{2}-\d{2}$/;

// The metric's own target as a goal, when it carries one with a number.
const targetOf = (e) => (e?.target && typeof e.target.goal === "number" ? e.target : null);

// Meets, near or misses against def; not-measured with no number; null with neither.
const tileStatus = (e, def, ok) => {
  if (def) return rateOf(def, ok ? e.value : null);
  return ok ? null : "not-measured";
};

const tileTip = (e, ok) => (ok ? srcTip(e) : `not measured: ${e?.could_not_check ?? "no collector reported it"}${e?.source ? `; ${e.source}` : ""}`);

// A weekly series reads as a sparkline, any other breakdown as bars.
function tileChart(e, ok, label) {
  const d = e?.detail ?? [];
  if (ok && d.length > 1 && d.every((x) => WEEK.test(String(x.label)))) return spark(d.map((x) => ({ label: x.label, value: x.value })), { label: label ?? e.label, unit: e.unit, width: 200, height: 40 });
  return ok && d.length ? bars(d, e.unit, { plain: d.length > 6 }) : "";
}

// One metric as a tile: label, value, a bullet against the site's own goal
// when the metric carries one, and its breakdown as a chart.
export function mtile(e, id, label) {
  const def = targetOf(e);
  const ok = isMeasured(e);
  const status = tileStatus(e, def, ok);
  const name = label ?? (e?.label && e.label !== id ? e.label : idLabel(id));
  return `<div class="mt${status ? ` s-${status}` : ""}" data-tip="${esc(tileTip(e, ok))}" tabindex="0"><p class="t-l">${esc(name)}</p><p class="mt-n">${status ? glyph(status) : ""}${esc(valueOf(e))}</p>${def ? bullet(def, ok ? e.value : null) : ""}${tileChart(e, ok, label)}</div>`;
}

// The ideal state a map, a Process tab or an outcome is held to, drawn as the
// Quality page draws a tab's: the summary, then its dated sources. Optional:
// a section with none draws nothing.
export const ideal = (id, doc, name, level) => (doc?.ideal ? idealBlock(esc(id), doc, name && esc(name), level) : "");

// A number rounded to one decimal, as text.
export const r1 = (n) => String(Math.round(n * 10) / 10);
// A metric's value with an optional suffix, or "not measured".
export const figText = (e, suffix) => (isMeasured(e) ? `${valueOf(e)}${suffix ? ` ${suffix}` : ""}` : "not measured");
// A figure's tooltip: label, value and source, or why it is not measured.
export const figTip = (e) => (isMeasured(e) ? `${e.label ?? ""}: ${valueOf(e)}; ${srcTip(e)}` : `not measured: ${e?.could_not_check ?? "no collector reported it"}`);
