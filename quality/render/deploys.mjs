// Draws chart: "deploys", the Deploy tab's list of production deploys
// (deploy session, 2026-11-03). page.mjs calls deploys(detail) and places
// the result full width at the top of the tab, as it does the ledger; this
// file escapes its own text.
//
// detail is one item per production code deploy, oldest first, from
// quality/collectors/site/deploy.mjs: { label (UTC time), value (merges shipped),
// commit, commit_from (tag, time, unknown), lead_hours (median for its
// merges), rollback, failed (why, or null), restore_hours }. Bars show the
// merges each deploy shipped; the table gives every deploy's numbers,
// newest first. A result is a glyph and a word, never color alone.

import { bars, esc, scrollBox, finite, fmt, glyph } from "./charts.mjs";

const FROM = { tag: "version tag", time: "main at upload", unknown: "not found" };

function result(r) {
  if (r.failed) return `<td class="vd"><span>${glyph("misses", "")}${esc(`failed: ${r.failed}`)}</span></td>`;
  if (r.rollback) return `<td class="vd"><span>${glyph("near", "")}rollback</span></td>`;
  return `<td class="vd"><span>${glyph("meets", "")}no fix needed</span></td>`;
}

// The Deploy tab's chart: merges per deploy as bars, then the table.
export function deploys(detail) {
  const rows = detail.filter((r) => r && typeof r.label === "string");
  const newest = [...rows].reverse();
  const head = ["Deployed (UTC)", "Commit", "Commit known by", "Merges shipped", "Median lead time", "Result", "Restored after"].map((h) => `<th scope="col">${h}</th>`).join("");
  const body = newest
    .map(
      (r) =>
        `<tr><th scope="row">${esc(r.label)}</th><td><code>${esc(r.commit ?? "–")}</code></td><td>${esc(FROM[r.commit_from] ?? "–")}</td><td class="num">${finite(r.value) ? esc(fmt(r.value)) : "–"}</td><td class="num">${finite(r.lead_hours) ? esc(fmt(r.lead_hours, "h")) : "–"}</td>${result(r)}<td class="num">${finite(r.restore_hours) ? esc(fmt(r.restore_hours, "h")) : "–"}</td></tr>`,
    )
    .join("");
  const shipped = bars(newest.map((r) => ({ label: r.label, value: r.value, unit: "merges" })), "merges");
  return `<figure class="lg-rank"><figcaption>Merges each deploy shipped, newest first</figcaption>${shipped}</figure>${scrollBox("Deploys", `<table class="lg dp"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`)}`;
}
