// Draws chart: "tools", the Tools tab's table of every direct dependency
// against the release-age rule (tools session, 2026-11-03). page.mjs calls
// tools(detail) and places the result full width at the top of the tab, as
// it does the deploys list; this file escapes its own text.
//
// detail is one item per direct dependency, from quality/collectors/tools/tools.mjs:
// { label, where, installed, eligible (newest release at least 14 days old),
// newest, released, status (behind, too new, current, not read),
// majors_behind, waiting_days }. One 100% bar counts the statuses; the table
// lists behind first, the longest wait on top. Status is a glyph and a word,
// never color alone. Security alerts stay on the Security tab, linked here.

import { esc, scrollBox, finite, glyph, stack } from "./charts.mjs";

const STATUS = {
  behind: ["misses", "behind"],
  "too new": ["near", "too new"],
  current: ["meets", "current"],
  "not read": ["not-measured", "not read"],
};
const ORDER = Object.keys(STATUS);

// Rows by status (behind first), the longest wait first within a status.
export function order(rows) {
  return [...rows].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || (b.waiting_days ?? -1) - (a.waiting_days ?? -1));
}

// The Tools tab's chart: a status bar over the table of dependencies.
export function tools(detail) {
  const rows = order(detail.filter((r) => r && typeof r.label === "string"));
  const counts = ORDER.map((s) => ({ label: STATUS[s][1], value: rows.filter((r) => r.status === s).length, unit: "dependencies" })).filter((c) => c.value > 0);
  const head = ["Package", "Used in", "Installed", "Latest allowed", "Newest", "Status", "Majors behind", "Waiting"].map((h) => `<th scope="col">${h}</th>`).join("");
  const cell = (v) => `<td class="num">${v === null || v === undefined || v === "" ? "–" : esc(String(v))}</td>`;
  const body = rows
    .map((r) => {
      const [g, word] = STATUS[r.status] ?? STATUS["not read"];
      return `<tr><th scope="row">${esc(r.label)}</th><td>${esc(r.where ?? "–")}</td>${cell(r.installed)}${cell(r.eligible)}${cell(r.newest)}<td class="vd"><span>${glyph(g, "")}${esc(word)}</span></td>${cell(finite(r.majors_behind) && r.majors_behind ? r.majors_behind : "")}${cell(finite(r.waiting_days) ? `${r.waiting_days} days` : "")}</tr>`;
    })
    .join("");
  return `<figure class="rp-bar"><figcaption>Direct dependencies by status; latest allowed is the newest release at least 14 days old. Security alerts are on the <a href="#security">Security tab</a>.</figcaption>${stack(counts, "dependencies")}</figure>${scrollBox("Dependencies", `<table class="lg tl"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`)}`;
}
