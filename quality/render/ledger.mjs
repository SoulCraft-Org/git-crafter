// Draws chart: "ledger", the Blockers tab's table of every restriction on
// Claude's work (blockers session, 2026-11-03). page.mjs calls
// ledger(detail, def) and places the result full width at the top of the
// tab, as it does the CI pipeline; this file escapes its own text.
//
// detail is one item per blocker, from quality/collectors/blockers/blockers.mjs:
// { label, group (Quality, Speed, Tokens), fires, false_alarm (a percent),
// hours, tokens (each over the last N events its source names, or null when
// not measured), verdict (helps, costs, not-measured) }. Two ranked bar
// charts, tokens and hours,
// costliest first, sit above the table. The verdict is a status glyph and a
// word, so it never relies on color alone. The styles are the "Blockers
// ledger" section of page.css.

import { bars, esc, scrollBox, finite, fmt, fmtCompact, glyph } from "./charts.mjs";

const GROUPS = ["Quality", "Speed", "Tokens"];
// Verdict: the status glyph it borrows, and its word.
const VERDICT = { helps: ["meets", "helps"], costs: ["misses", "costs"], "not-measured": ["not-measured", "not measured"] };
export const RANKED = 8;

const num = (v, text) => `<td class="num">${finite(v) ? esc(text(v)) : "–"}</td>`;

function verdictCell(v) {
  const [status, word] = VERDICT[v] ?? VERDICT["not-measured"];
  return `<td class="vd"><span>${glyph(status, "")}${esc(word)}</span></td>`;
}

// The costliest blockers by one measure, at most RANKED, as bars.
export function ranked(rows, key, unit, title) {
  const top = rows
    .filter((r) => finite(r[key]) && r[key] > 0)
    .sort((a, b) => b[key] - a[key])
    .slice(0, RANKED);
  if (!top.length) return "";
  return `<figure class="lg-rank"><figcaption>${esc(title)}</figcaption>${bars(top.map((r) => ({ label: r.label, value: r[key], unit })), unit)}</figure>`;
}

// The Blockers tab's chart: rankings, then the table by group.
export function ledger(detail) {
  const rows = detail.filter((r) => r && typeof r.label === "string");
  // Groups in GROUPS order; a group the collector adds later goes last.
  const groups = [...new Set([...GROUPS, ...rows.map((r) => String(r.group))])];
  const body = groups
    .map((group) => {
      const mine = rows.filter((r) => String(r.group) === group);
      if (!mine.length) return "";
      const lines = mine
        .map(
          (r) =>
            `<tr><th scope="row">${esc(r.label)}</th>${num(r.fires, (v) => fmt(v))}${num(r.false_alarm, (v) => fmt(v, "%"))}${num(r.hours, (v) => fmt(v, "h"))}${num(r.tokens, (v) => fmtCompact(v))}${verdictCell(r.verdict)}</tr>`,
        )
        .join("");
      return `<tbody><tr class="lg-g"><th scope="rowgroup" colspan="6">${esc(group)}</th></tr>${lines}</tbody>`;
    })
    .join("");
  const head = ["Blocker", "Fires", "False alarms", "Hours", "Tokens", "Verdict"].map((h) => `<th scope="col">${h}</th>`).join("");
  return `<div class="lg-ranks">${ranked(rows, "tokens", "tokens", "Tokens")}${ranked(rows, "hours", "h", "Hours")}</div>${scrollBox("Ledger", `<table class="lg"><thead><tr>${head}</tr></thead>${body}</table>`)}`;
}
