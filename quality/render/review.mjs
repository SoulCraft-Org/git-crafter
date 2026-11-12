// A tab's review: score, histogram, heatmap and the drill-down under it.
// page.mjs passes the repo's URL and its reviews folder.

import { scrollBox, finite, glyph, histogram, meter, scoreStatus, esc } from "./charts.mjs";
import { cellItems, criterionLabel, pageLabel, rampStep, reviewGrid, weakestCell, widthMode } from "./model.mjs";

// ---- Review: score, histogram, heatmap, drill-down ---------------------------

const HEATMAP_ROWS = 12;
const issueLink = (repo, n) => (!Number.isInteger(n) ? "" : repo ? `<a href="${esc(repo)}/issues/${n}">Issue #${n}</a>` : `Issue #${n}`);
const scoreText = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
const widthWord = (w) => ({ d: `Desktop ${w}`, p: `Phone ${w}` })[widthMode(w)] ?? "";

function findingHtml(it, grid, repo) {
  const where = grid.hasArea && it.level !== "area" ? it.page : widthWord(it.width);
  const field = (name, text) => (text ? `<dt>${name}</dt><dd>${esc(text)}</dd>` : "");
  return `<article class="finding"><p class="fh"><span class="sc k${rampStep(it.score)}">${scoreText(it.score)}</span>${where ? `<span class="where">${esc(where)}</span>` : ""}${issueLink(repo, it.tracking)}</p><dl>${field("Finding", it.finding)}${field("Fix", it.fix)}${field("Evidence", it.evidence)}</dl></article>`;
}

function drillHtml(review, grid, page, criterion, repo) {
  return `<p class="drill-h"><b>${esc(pageLabel(page))}</b><span>${esc(criterionLabel(criterion))}</span></p>${cellItems(review, grid, page, criterion)
    .map((it) => findingHtml(it, grid, repo))
    .join("")}`;
}

// The items ship once as JSON for the drill-down, packed as index arrays
// ([page, criterion, score, width, area, issue, finding, fix, evidence])
// to keep the page under its 1,000 KB budget. Every "<" is written as the
// escape \u003c, so no finding can close the script element.
function reviewJson(review) {
  const pages = [...new Set(review.items.map((it) => it.page))];
  const criteria = [...new Set(review.items.map((it) => it.criterion))];
  const items = review.items.map((it) => {
    const row = [pages.indexOf(it.page), criteria.indexOf(it.criterion), it.score, it.width ?? null, it.level === "area" ? 1 : 0, it.tracking ?? null, it.finding ?? null, it.fix ?? null, it.evidence ?? null];
    while (row.length > 3 && (row[row.length - 1] === null || row[row.length - 1] === "")) row.pop();
    return row;
  });
  return JSON.stringify({ p: pages, c: criteria, i: items }).replace(/</g, "\\u003c");
}

function heatmap(tab, grid) {
  const head = grid.columns.map((c) => `<th scope="col" data-key="${esc(c)}">${esc(criterionLabel(c))}</th>`).join("");
  const body = grid.rows
    .map((row, i) => {
      const cells = row.cells
        .map((cell, j) => {
          if (!cell) return "<td></td>";
          // data-b is the mean over both widths; data-d and data-p appear only
          // where they differ from it, and empty where that width has no score.
          const words = `${scoreText(cell.b)}: ${pageLabel(row.page)}, ${criterionLabel(grid.columns[j])}`;
          const data = ["d", "p"].map((m) => (cell[m] === cell.b ? "" : ` data-${m}="${finite(cell[m]) ? cell[m] : ""}"`)).join("");
          return `<td><button class="cell k${rampStep(cell.b)}" data-b="${cell.b}"${data} aria-label="${esc(words)}">${scoreText(cell.b)}</button></td>`;
        })
        .join("");
      return `<tr data-page="${esc(row.page)}"${i >= HEATMAP_ROWS ? ' class="extra"' : ""}><th scope="row">${esc(pageLabel(row.page))}</th>${cells}</tr>`;
    })
    .join("");
  return `${scrollBox("Heatmap", `<table class="heatmap" id="${tab}-hm"><thead><tr><th scope="col" class="pg">${grid.hasArea ? "Area" : "Page"}</th>${head}</tr></thead><tbody>${body}</tbody></table>`)}`;
}

// A tab's review block: score, histogram, heatmap and drill-down; empty
// when the tab has no review.
export function reviewBlock(tab, review, repo, reviews) {
  if (!review) return "";
  const grid = reviewGrid(review);
  const weak = weakestCell(grid);
  const nRows = grid.rows.length;
  const rampKey = `<span class="ramp-key" aria-hidden="true">weak<i class="k1"></i><i class="k2"></i><i class="k3"></i><i class="k4"></i><i class="k5"></i>strong</span>`;
  const modes = grid.hasWidths
    ? `<div class="seg" role="group" aria-label="Width" hidden><button type="button" data-m="d" aria-pressed="false">Desktop</button><button type="button" data-m="p" aria-pressed="false">Phone</button><button type="button" data-m="b" aria-pressed="true">Both</button></div>`
    : "";
  const files = grid.findings.length
    ? `<details class="findings"><summary>${grid.findings.length} file findings</summary><ol>${[...grid.findings]
        .sort((a, b) => a.score - b.score)
        .map(
          (it) =>
            `<li><span class="sc k${rampStep(it.score)}">${scoreText(it.score)}</span><span class="fp">${esc(it.page)}</span><span class="crit">${esc(criterionLabel(it.criterion))}</span>${issueLink(repo, it.tracking)}<p>${esc(it.finding)}</p></li>`,
        )
        .join("")}</ol></details>`
    : "";
  return `<section class="review" data-review="${tab}" aria-labelledby="${tab}-rv">
<div class="rv-head"><h3 id="${tab}-rv">Review</h3><div class="sb"><p class="sb-n">${glyph(scoreStatus(review.score))}${review.score}</p>${meter(review.score, "Review score")}</div>${histogram(grid.histogram)}<p class="small">${grid.scored} ${grid.hasArea ? "area scores" : "scores"}, ${esc(review.date)}, ${repo ? `<a href="${esc(repo)}/blob/HEAD/${reviews.split("/").map(encodeURIComponent).join("/")}/${encodeURIComponent(review.file)}">${esc(review.file)}</a>` : esc(review.file)}</p></div>
<div class="rv-body"><div class="rv-map"><div class="hm-bar">${modes}${rampKey}</div>
${heatmap(tab, grid)}
${nRows > HEATMAP_ROWS ? `<button type="button" class="more-rows" hidden>Show all ${nRows} ${grid.hasArea ? "areas" : "pages"}</button>` : ""}</div>
<div class="drill" id="${tab}-drill" aria-live="polite">${weak ? drillHtml(review, grid, grid.rows[weak.r].page, grid.columns[weak.c], repo) : ""}</div></div>
${files}
<script type="application/json" class="rv-data">${reviewJson(review)}</script>
</section>`;
}
