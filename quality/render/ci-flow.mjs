// Draws chart: "flow", the Actions tab's pipeline, left to right (orchestrator
// contract, 2026-11-02). page.mjs calls ciFlow(detail, def) and places the
// result full width at the top of the tab; this file escapes its own text.
//
// detail is one item per step: { label, value (median minutes, or null when
// nothing times it), unit, stage, kind (hook, workflow, job, manual), runs,
// file, pass_rate (0 to 100, or null), light_share (optional: the share of
// runs that skipped their work) }. Each stage is a column, in
// STAGES order; its parallel steps stack in the column.
//
// The one bold element is the rail. In every column the slowest step sits on
// top, so the slowest step of each stage lines up on one row, and a night rail
// joins them edge to edge: the critical path reads as one straight line.
// Everything else stays quiet: hairline nodes, one magnitude bar per node in
// community blue (median minutes against the slowest step on the page), and a
// status glyph for the pass rate, which never relies on color alone.
//
// Each node is a <button> that opens a native popover with the step's
// details on click or Enter, and Escape closes it, with no script. A table
// twin under the drawing lists every step's time and pass rate for screen
// readers and for a browser without popovers. The styles are the "CI
// pipeline" section of page.css.

import { esc, finite, glyph } from "./charts.mjs";

export const STAGES = [
  ["edit", "Edit"],
  ["commit", "Commit"],
  ["push", "Push"],
  ["ci", "Pull request checks"],
  ["review", "Review"],
  ["merge", "Merge to main"],
  ["deploy", "Deploy"],
];

const KIND_SHORT = { hook: "Hook", workflow: "Workflow", job: "Job", manual: "Person" };

const KIND_WORD = {
  hook: "A hook on the laptop; nothing records its time",
  workflow: "An automated workflow: a GitHub Actions workflow or a Cloudflare build",
  job: "A GitHub Actions job",
  manual: "A step a person takes",
};

// Pass-rate bands: 95 and 85, the goal and near band of a CI success-rate
// metric the template has since cut.
export function passStatus(rate) {
  if (!finite(rate)) return "not-measured";
  return rate >= 95 ? "meets" : rate >= 85 ? "near" : "misses";
}

const PASS_WORD = {
  meets: "95% or more of runs pass",
  near: "85 to 94% of runs pass",
  misses: "under 85% of runs pass",
  "not-measured": "pass rate not measured",
};

const minutesText = (v) => (finite(v) ? `${Math.round(v * 10) / 10} min` : "not timed");
const passText = (r) => (finite(r) ? `${Math.round(r * 10) / 10}% of runs passed; cancelled runs are left out` : "not measured");

/**
 * Steps grouped into columns in STAGES order, any unknown stage after them
 * in first-seen order. In each column the slowest timed step comes first and
 * is the column's critical step; a column with no timed step keeps file order
 * and its first step carries the rail.
 */
export function layout(detail) {
  const steps = (Array.isArray(detail) ? detail : []).filter((d) => d && typeof d === "object");
  const order = STAGES.map(([id]) => id);
  for (const s of steps) if (!order.includes(s.stage)) order.push(s.stage);
  const columns = [];
  for (const id of order) {
    const own = steps.filter((s) => s.stage === id);
    if (!own.length) continue;
    const timed = own.filter((s) => finite(s.value));
    const slowest = timed.length ? timed.reduce((a, b) => (b.value > a.value ? b : a)) : own[0];
    const rest = own.filter((s) => s !== slowest);
    columns.push({
      id,
      name: STAGES.find(([k]) => k === id)?.[1] ?? String(id ?? "Other"),
      minutes: timed.length ? slowest.value : null,
      steps: [{ ...slowest, critical: true }, ...rest.map((s) => ({ ...s, critical: false }))],
    });
  }
  return columns;
}


// The step's share of the slowest step, as a bar, or nothing when untimed.
function barHtml(step, max) {
  if (!finite(step.value) || !(max > 0)) return "";
  const width = Math.max(0, Math.min(100, (step.value / max) * 100));
  return `<span class="cf-track"><span class="cf-bar" style="width:${width.toFixed(1)}%"></span></span>`;
}

function medianText(step) {
  if (!finite(step.value)) return "Not timed";
  return `${Math.round(step.value * 10) / 10} minutes${finite(step.light_share) ? " when it does its work" : ""}`;
}

function skipsRow(step) {
  return finite(step.light_share) ? `<dt>Skips</dt><dd>${esc(`${Math.round(step.light_share)}% of sampled runs found nothing to check`)}</dd>` : "";
}

function node(step, id, max) {
  const status = passStatus(step.pass_rate);
  const kind = String(step.kind ?? "");
  const path = step.critical ? "<dt>Path</dt><dd>The slowest step in its stage, on the rail</dd>" : "";
  return `<li class="cf-node${step.critical ? " crit" : ""}" data-kind="${esc(kind)}">
<button type="button" class="cf-btn" popovertarget="${id}"><span class="cf-l1">${glyph(status, PASS_WORD[status])}<span class="cf-name">${esc(step.label)}</span></span><span class="cf-min">${esc(minutesText(step.value))}</span>${barHtml(step, max)}</button>
<div class="cf-pop" id="${id}" popover><h5>${esc(step.label)}</h5><dl><dt>Median</dt><dd>${esc(medianText(step))}</dd>${skipsRow(step)}<dt>Pass rate</dt><dd>${glyph(status, "")} ${esc(passText(step.pass_rate))}</dd><dt>What runs</dt><dd>${esc(step.runs ?? "")}</dd><dt>Defined in</dt><dd>${esc(step.file ?? "")}</dd><dt>Kind</dt><dd>${esc(KIND_WORD[kind] ?? kind)}</dd>${path}</dl><button type="button" class="cf-close" popovertarget="${id}" popovertargetaction="hide">Close</button></div>
</li>`;
}

// Draws a pipeline's steps as columns of stages, each step a button that
// opens its numbers; detail is the ci metric's per-step list.
export function ciFlow(detail, def) {
  const columns = layout(detail);
  if (!columns.length) return `<p class="empty">No pipeline steps were read.</p>`;
  const base = `cf-${String(def?.id ?? "flow").replace(/[^A-Za-z0-9_-]/g, "-")}`;
  const max = Math.max(0, ...columns.flatMap((c) => c.steps.map((s) => (finite(s.value) ? s.value : 0))));
  let n = 0;
  const stages = columns
    .map((c) => {
      const nodes = c.steps.map((s) => node(s, `${base}-${n++}`, max)).join("");
      return `<li class="cf-stage"><h4 class="cf-sh"><span>${esc(c.name)}</span><span class="cf-st">${esc(finite(c.minutes) ? minutesText(c.minutes) : "")}</span></h4><ul class="cf-nodes">${nodes}</ul></li>`;
    })
    .join("");
  const rows = columns
    .flatMap((c) =>
      c.steps.map(
        (s) =>
          `<tr><td>${esc(c.name)}</td><td>${esc(s.label)}${s.critical ? " (rail)" : ""}</td><td>${esc(KIND_SHORT[s.kind] ?? s.kind ?? "")}</td><td class="num">${esc(minutesText(s.value))}</td><td class="num">${esc(finite(s.pass_rate) ? `${Math.round(s.pass_rate * 10) / 10}%` : "not measured")}</td></tr>`,
      ),
    )
    .join("");
  const label = esc(def?.label ?? "Pipeline");
  return `<div class="cf">
<p class="cf-key"><span><i class="cf-rail"></i>The slowest step of each stage</span><span>${glyph("meets", "")}95% or more pass</span><span>${glyph("near", "")}85 to 94%</span><span>${glyph("misses", "")}Under 85%</span><span>${glyph("not-measured", "")}Not measured</span><span><i class="cf-dash"></i>Runs on the laptop</span><span><i class="cf-dot"></i>A person</span><span>Blue bar: median minutes</span></p>
<div class="cf-scroll" role="region" aria-label="${label}, from edit to deploy; scrolls sideways" tabindex="0"><ol class="cf-stages">${stages}</ol></div>
<details class="cf-table"><summary>Every step as a table</summary><div class="cf-scroll" role="region" aria-label="Every step as a table; scrolls sideways" tabindex="0"><table><thead><tr><th>Stage</th><th>Step</th><th>Kind</th><th class="num">Median</th><th class="num">Pass rate</th></tr></thead><tbody>${rows}</tbody></table></div></details>
</div>`;
}
