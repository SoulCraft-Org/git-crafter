// Draws chart: "repos", the Tokens tab's split by repo (tokens session,
// 2026-11-03). page.mjs calls repos(detail) and places the result full width
// at the top of the tab, as it does the ledger; this file escapes its own text.
//
// detail is one item per repo, from the Claude pack's tokens collector: { label,
// value (tokens), share, cache_read_share, merged, tokens_per_pr,
// waste_share, latest_rework, per_hour }, each null when not measured. A
// stacked bar shows each repo's share of the tokens; the table gives every
// repo's numbers. The styles are the ledger's (page.css) plus .rp-bar.

import { esc, scrollBox, finite, fmt, fmtCompact, stack } from "./charts.mjs";

// Column key, heading, and how a value reads.
export const COLUMNS = [
  ["value", "Tokens", (v) => fmtCompact(v)],
  ["merged", "Merged PRs", (v) => fmt(v)],
  ["tokens_per_pr", "Tokens per PR", (v) => fmtCompact(v)],
  ["cache_read_share", "Cache read", (v) => fmt(v, "%")],
  ["waste_share", "On closed PRs", (v) => fmt(v, "%")],
  ["latest_rework", "Rework, latest PR", (v) => fmtCompact(v)],
  ["per_hour", "Per active hour", (v) => fmtCompact(v)],
];

// The Tokens tab's chart: each repo's share as one bar, then the table.
export function repos(detail) {
  const rows = detail.filter((r) => r && typeof r.label === "string");
  const bar = stack(rows.map((r) => ({ label: r.label, value: r.value, unit: "tokens" })), "tokens");
  const head = `<th scope="col">Repo</th>${COLUMNS.map(([, h]) => `<th scope="col">${h}</th>`).join("")}`;
  const body = rows
    .map((r) => `<tr><th scope="row">${esc(r.label)}</th>${COLUMNS.map(([key, , read]) => `<td class="num">${finite(r[key]) ? esc(read(r[key])) : "–"}</td>`).join("")}</tr>`)
    .join("");
  return `<figure class="rp-bar"><figcaption>Tokens by repo</figcaption>${bar}</figure>${scrollBox("Repos", `<table class="lg rp"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`)}`;
}
