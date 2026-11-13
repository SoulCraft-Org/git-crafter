// Draws chart: "credits", the Credits tab's table of every free tier, free
// credit and plan allowance (credits session, 2026-11-03). page.mjs calls
// credits(detail) and places the result full width at the top of the tab,
// as it does the ledger; this file escapes its own text.
//
// detail is one item per allowance, from the Credits pack's collector (SoulCraft-Org/compute-crafter):
// { label, lane, allowance, unit, per, used, used_floor, unused, used_share,
// pool (an org-wide CI pool), resets, status (over, idle, not read, used up, unclaimed), replaces (its
// lane is over budget), could_take_over, claim_needs }, numbers null when
// not read. One 100% bar counts the statuses; the table lists the CI pools
// first, then the rows the goal counts. Status is a glyph and a word, never color alone.

import { esc, scrollBox, finite, fmtCompact, glyph, stack } from "./charts.mjs";

// Status: the glyph it borrows and its word, in table order.
const STATUS = {
  over: ["misses", "over budget"],
  idle: ["near", "idle"],
  unclaimed: ["not-measured", "unclaimed"],
  "not read": ["not-measured", "use not read"],
  "used up": ["meets", "used up"],
};
const ORDER = Object.keys(STATUS);

const amount = (v, unit) => (finite(v) ? esc(fmtCompact(v, unit === "USD" ? "" : unit)) + (unit === "USD" ? " USD" : "") : "–");

function statusCell(r) {
  const [g, word] = STATUS[r.status] ?? STATUS["not read"];
  const extra = r.replaces && r.status !== "over" ? ", could take over" : "";
  return `<td class="vd"><span>${glyph(r.replaces && (r.status === "idle" || r.status === "unclaimed") ? "misses" : g, "")}${esc(word + extra)}</span></td>`;
}

// The CI pools first, then the rows the goal counts, then by status, then
// as the collector listed them (Array.prototype.sort is stable).
export function order(rows) {
  const rank = (r) => (r.pool ? 0 : r.replaces && r.status !== "over" ? 10 : 20) + ORDER.indexOf(r.status);
  return [...rows].sort((a, b) => rank(a) - rank(b));
}

function usedText(r) {
  const used = finite(r.used) ? `${r.used_floor ? "at least " : ""}${amount(r.used, r.unit)}` : "–";
  const share = finite(r.used_share) && !r.used_floor ? ` (${esc(fmtCompact(r.used_share, "%"))})` : "";
  return used + share;
}

function creditRow(r) {
  const included = finite(r.allowance) ? amount(r.allowance, r.unit) : esc(r.per || "–");
  return `<tr><th scope="row">${esc(r.label)}</th><td>${esc(r.lane ?? "–")}</td><td class="num">${included}</td><td class="num">${usedText(r)}</td><td class="num">${amount(r.unused, r.unit)}</td><td>${esc(r.resets ?? "–")}</td>${statusCell(r)}<td>${esc(r.could_take_over || "–")}</td><td>${esc(r.claim_needs || "–")}</td></tr>`;
}

// The Credits tab's chart: a status bar over the table of allowances.
export function credits(detail) {
  const rows = order(detail.filter((r) => r && typeof r.label === "string"));
  const counts = ORDER.map((s) => ({ label: STATUS[s][1], value: rows.filter((r) => r.status === s).length, unit: "allowances" })).filter((c) => c.value > 0);
  const head = ["Allowance", "Lane", "Included", "Used", "Unused", "Resets", "Status", "Could take over", "To claim or read it"].map((h) => `<th scope="col">${h}</th>`).join("");
  const body = rows.map(creditRow).join("");
  return `<figure class="rp-bar"><figcaption>Allowances by status</figcaption>${stack(counts, "allowances")}</figure>${scrollBox("Allowances", `<table class="lg cr"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`)}`;
}
