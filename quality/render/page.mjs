// Lays out the Quality, Speed and Consumption page: an overview (the range, the totals,
// the scoreboard, the work queue, what was not measured) and one panel per
// tab the repo shows (header, its ideal state, review heatmap, filter chips,
// then its Quality, Speed and Consumption sections).
// Visual first: charts and numbers, few words. The drawings come from
// charts.mjs, the derived numbers from model.mjs; page.css and client.js are
// read once, when this module loads. The repo's name, link and tabs come in
// with each render (build.mjs, from the repo's config).

import { existsSync, readFileSync } from "node:fs";

import { DEFAULT_TABS, isMeasured, KIND_LIST, mergeMetrics, newestReviews, scoreTab } from "../score.mjs";
import {
  bars,
  bullet,
  esc,
  finite,
  fmt,
  fmtCompact,
  funnel,
  glyph,
  labelFirst,
  meter,
  miniMassif,
  range,
  scoreStatus,
  scrollBox,
  spark,
  stack,
  STATUS_WORD,
  statusCounts,
  statusStack,
} from "./charts.mjs";
import { icon, iconId, shortName, SPRITE } from "./icons.mjs";
import { ledger } from "./ledger.mjs";
import { reviewBlock } from "./review.mjs";
import { repos } from "./repos.mjs";
import { credits } from "./credits.mjs";
import { deploys } from "./deploys.mjs";
import { tools } from "./tools.mjs";
import { groupRows, historyFor, notMeasured, overall, worstGaps, workQueue } from "./model.mjs";

// The page ships its styles and client script without comments and without
// the whitespace a browser ignores; the source files keep both. This keeps
// about 9 KB of the 1,000 KB budget (build.mjs) for metric rows. One left to
// right pass drops CSS comments and sets strings aside, so a comment mark
// inside a string stays and a quote inside a comment goes; a brace, comma or
// colon inside a string is never touched. A declaration loses the space
// after its colon only inside an innermost block, where no selector can be.
// The script loses whole comment lines and the indent of each line;
// client.js has no string that spans lines, which page.test.mjs checks.
export const CSS_STRING_OR_COMMENT = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\/\*[\s\S]*?\*\//g;
// CSS with comments and spare whitespace removed, strings kept as written.
export function tightCss(css) {
  const strings = [];
  return css
    .replace(CSS_STRING_OR_COMMENT, (_, s) => (s ? `\u0000${strings.push(s) - 1}\u0000` : ""))
    .replace(/\s*([{};,])\s*/g, "$1")
    .replace(/;\}/g, "}")
    .replace(/\{([^{}]*)\}/g, (_, body) => `{${body.replace(/(^|;)([-\w]+)\s*:\s*/g, "$1$2:")}}`)
    .replace(/\}/g, "}\n")
    .trim()
    .replace(/\u0000(\d+)\u0000/g, (_, i) => strings[Number(i)]);
}
// Client JS with whole-line comments and indentation removed.
export const tightJs = (js) => js.replace(/^[ \t]*\/\/.*\n/gm, "").replace(/^[ \t]+/gm, "").replace(/\n{2,}/g, "\n");

// page.css, then its second half: the figures. Two files, so each stays under the length limit.
const PAGE_CSS = tightCss(["./page.css", "./page-figures.css"].map((f) => readFileSync(new URL(f, import.meta.url), "utf8")).join(""));
const CLIENT_JS = tightJs(readFileSync(new URL("./client.js", import.meta.url), "utf8"));

// chart: "flow" (a pipeline, stage by stage) is drawn by render/ci-flow.mjs,
// the CI session's file, which escapes its own text. Until that file lands a
// flow falls back to a plain table; once it exists, any error in it fails the
// build instead of hiding behind the fallback.
const FLOW = new URL("./ci-flow.mjs", import.meta.url);
const ciFlow = existsSync(FLOW) ? (await import(FLOW.href)).ciFlow : null;

// The tabs and the repo of the render in progress. render() sets both before
// it draws and nothing awaits in between, so one page never reads another's.
let NAMES = new Map(DEFAULT_TABS);
let REPO = null;
let REVIEWS = "quality/reviews";
const tabName = (id) => NAMES.get(id) ?? id;
const goalText = (def) => `goal ${def.direction === "higher" ? "≥" : "≤"} ${fmtCompact(def.goal)}`;
const valueText = (row) => (isMeasured(row.entry) ? fmtCompact(row.entry.value, row.def.unit) : "–");
const readTime = (iso) => (typeof iso === "string" && iso.length >= 16 ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "");
// How far a value sits from its goal, in its unit; a percent's gap is points.
const gapText = (def, value) => `${fmtCompact(Math.abs(value - def.goal), def.unit === "%" ? "pts" : def.unit)} ${def.direction === "lower" ? "over" : "under"} goal`;
// Tabs that open with their worst gaps, and tabs whose rows draw a
// week-by-week line, to show a trend such as fewer subagents.
const GAP_TABS = new Set(["blockers", "deploy", "credits", "tools"]);
const WEEKLY_TABS = new Set(["blockers", "tokens"]);
const FULL_WIDTH = new Set(["flow", "ledger", "repos", "deploys", "credits", "tools"]);
// The full-width drawings each file owns; flow falls back to a table above.
const FIGURES = { ledger, repos, deploys, credits, tools };
const tabChip = (id) => `<a class="tabchip" href="#${id}">${icon(id)}${esc(shortName(id, tabName(id)))}</a>`;

// ---- Header and nav ---------------------------------------------------------

function pips(q, s) {
  const pip = (p) => `<span class="pip">${glyph(scoreStatus(p.score), "")}${finite(p.score) ? p.score : "–"}</span>`;
  return `<span class="pips">${pip(q)} ${pip(s)}</span>`;
}

function nav(results, total) {
  const words = (label, name, q, s) => `${labelFirst(label, name)}: quality ${q.score ?? "not measured"}, speed ${s.score ?? "not measured"}`;
  // The name starts with the link's visible text, label then both scores (WCAG 2.5.3).
  const shown = (label, q, s) => `${label} ${finite(q.score) ? q.score : "–"} ${finite(s.score) ? s.score : "–"}`;
  const link = (id, name, label, q, s) =>
    `<a href="#${id}" aria-label="${esc(`${shown(label, q, s)}. ${words(label, name, q, s)}`)}" data-tip="${esc(words(label, name, q, s))}"><span class="nl">${icon(id)}${esc(label)}</span> ${pips(q, s)}</a>`;
  return `<nav class="tabnav" aria-label="Views">${link("overview", "Overview", "Overview", total.quality, total.speed)}${results
    .map((r) => link(r.tab, tabName(r.tab), shortName(r.tab, tabName(r.tab)), r.quality, r.speed))
    .join("")}</nav>`;
}

// ---- Metric rows --------------------------------------------------------------

// The breakdown under an open row. chart names the drawing (CHARTS in
// score.mjs): spark as a line over its values, funnel and stack as their own
// shapes, number and table as plain rows, bar and gauge as bars.
function breakdown(row) {
  const { def, entry } = row;
  if (!isMeasured(entry) || !Array.isArray(entry.detail) || entry.detail.length === 0) return "";
  const detail = entry.detail;
  if (def.chart === "spark") {
    const labeled = detail.map((d) => (d.partial ? { ...d, label: `${d.label} so far` } : d));
    return `${spark(detail, { label: def.label, unit: def.unit, width: 300, height: 72 })}${bars(labeled, def.unit)}`;
  }
  if (FULL_WIDTH.has(def.chart)) return ""; // drawn full width at the top of the tab
  if (def.chart === "funnel") return funnel(detail, def.unit);
  if (def.chart === "stack") return stack(detail, def.unit);
  if (def.chart === "number" || def.chart === "table") return bars(detail, def.unit, { plain: true });
  return bars(detail, def.unit);
}

// The value to full precision, when the short form hides digits.
function exactLine(def, entry) {
  if (!isMeasured(entry) || fmtCompact(entry.value, def.unit) === fmt(entry.value, def.unit)) return "";
  return `<p class="exact">${esc(fmt(entry.value, def.unit))}</p>`;
}

function gapLine(row) {
  const { def, entry, status } = row;
  return isMeasured(entry) && status !== "meets" ? `<p class="gap">Gap: ${esc(gapText(def, entry.value))}</p>` : "";
}

// The week-by-week line, and a note on older reads left out of it.
function weeklyFigure(def, history) {
  const { points: weeks, dropped } = history ? historyFor(history, def) : { points: [], dropped: 0 };
  const redefined = dropped ? `; ${dropped} older ${dropped === 1 ? "read" : "reads"} left out, measured before the metric was redefined` : "";
  if (weeks.length > 1) return `<figure class="trend wk">${spark(weeks, { label: `${def.label}, week by week`, unit: def.unit, width: 240, height: 48 })}<figcaption>Week by week${redefined}</figcaption></figure>`;
  return dropped ? `<p class="small">Week by week${redefined}.</p>` : "";
}

function sourceLines(def, entry) {
  const read = readTime(entry?.read_at);
  const goal = def.goal_source ? `<p class="src">Goal: ${esc(def.goal_source)}</p>` : "";
  return `<p class="src">${esc(entry?.source ?? def.source ?? "")}${read ? ` <span class="read">read ${esc(read)}</span>` : ""}</p>${goal}`;
}

function metricRow(row, history) {
  const { def, entry, status } = row;
  const measured = isMeasured(entry);
  const means = typeof def.means === "string" && def.means ? `<p class="means">${esc(def.means)}</p>` : "";
  const reason = measured ? "" : `<p class="reason">${esc(entry?.could_not_check ?? "No collector reported this metric.")}</p>`;
  return `<details class="metric s-${status}" id="m-${esc(def.id)}">
<summary>${glyph(status)}<span class="lbl">${esc(def.label)}</span><span class="val">${esc(valueText(row))}</span>${bullet(def, measured ? entry.value : null)}<span class="goal">${esc(goalText(def))}</span></summary>
<div class="more">${means}${exactLine(def, entry)}${gapLine(row)}${weeklyFigure(def, history)}${reason}${breakdown(row)}${sourceLines(def, entry)}</div>
</details>`;
}

// One category's section: what ideal looks like there, then its metrics.
// A category with none says so: every tab is scored on all three.
function kindColumn(tab, kind, rows, history, ideal) {
  const title = kind[0].toUpperCase() + kind.slice(1);
  const aim = ideal?.[kind] ? `<p class="aim">${esc(ideal[kind])}</p>` : "";
  if (!rows.length) return `<section class="kind" aria-labelledby="${tab}-${kind}"><h3 id="${tab}-${kind}">${title}</h3>${aim}<p class="empty">No ${kind} metric yet.</p></section>`;
  const groups = groupRows(rows)
    .map(({ group, rows: list, mean }) => {
      const body = list.map((row) => metricRow(row, history)).join("\n");
      if (!group) return `<div class="group">${body}</div>`;
      return `<div class="group"><h4>${esc(group)}<span class="gchip s-${scoreStatus(mean)}">${glyph(scoreStatus(mean), "")}${mean ?? "–"}</span></h4>${body}</div>`;
    })
    .join("");
  return `<section class="kind" aria-labelledby="${tab}-${kind}"><h3 id="${tab}-${kind}">${title}</h3>${aim}${groups}</section>`;
}

function chips(rows) {
  const counts = statusCounts(rows);
  const chip = (f, label, n, pressed = false) =>
    `<button type="button" data-f="${f}" aria-pressed="${pressed}"${n === 0 ? " disabled" : ""}>${f === "all" ? "" : glyph(f, "")}${label}<b>${n}</b></button>`;
  return `<div class="chips" role="group" aria-label="Show metrics" hidden>${chip("all", "All", rows.length, true)}${chip("misses", "Misses", counts.misses)}${chip("near", "Near", counts.near)}${chip("meets", "Meets", counts.meets)}${chip("not-measured", "Not measured", counts["not-measured"])}</div>`;
}

// ---- Tab panel ----------------------------------------------------------------

function scoreBlock(label, part, extra = "") {
  return `<div class="sb"><p class="sb-l">${label}</p><p class="sb-n">${glyph(scoreStatus(part.score))}${finite(part.score) ? part.score : "–"}</p>${meter(part.score, label)}<p class="small">${part.measured} of ${part.total} measured</p>${extra}</div>`;
}

function trend(history, tab, kind) {
  const points = history.map((h) => ({ label: h.date, value: h.scores[tab]?.[kind].score })).filter((p) => finite(p.value));
  const line = spark(points, { label: `${kind} score by run`, width: 120, height: 40 });
  return line ? `<figure class="trend">${line}<figcaption>${kind === "quality" ? "Quality" : "Speed"} by run</figcaption></figure>` : "";
}

// A flow metric's pipeline, a ledger metric's blockers, a repos metric's
// split, the deploys list or the credits table, full width above the metric rows; its row stays in its column for
// the status, the filters and Fix first.
function flowFigure(row) {
  const { def, entry } = row;
  if (!isMeasured(entry) || !Array.isArray(entry.detail) || entry.detail.length === 0) return "";
  const body =
    FIGURES[def.chart] ? FIGURES[def.chart](entry.detail) : typeof ciFlow === "function" ? ciFlow(entry.detail, def) : bars(entry.detail, def.unit, { plain: true });
  return `<section class="flow${def.chart === "flow" ? "" : ` ${def.chart}`}" aria-labelledby="flow-${esc(def.id)}"><h3 id="flow-${esc(def.id)}">${esc(def.label)}</h3>${body}</section>`;
}

// The worst gaps on a tab, above everything else in it.
function gapList(rows) {
  const worst = worstGaps(rows);
  if (!worst.length) return "";
  return `<section class="gaps" aria-labelledby="gaps-h"><h3 id="gaps-h">Worst gaps</h3><ol class="fix">${worst
    .map(
      (row, i) =>
        `<li><span class="rank">${i + 1}</span><a class="lbl" href="#m-${esc(row.def.id)}">${esc(row.def.label)}</a><span class="val">${esc(valueText(row))}</span>${bullet(row.def, row.entry.value)}<span class="goal">${esc(gapText(row.def, row.entry.value))}</span></li>`,
    )
    .join("")}</ol></section>`;
}

// A tab's parts as a table: what ideal looks like for each piece of its area, and how to set it up.
function partsTable(parts) {
  if (!parts?.length) return "";
  const rows = parts.map((p) => `<tr><th scope="row">${esc(p.part)}</th><td>${esc(p.ideal)}</td><td>${esc(p.setup)}</td></tr>`).join("");
  return scrollBox("Ideal state, part by part", `<table class="ideal-parts" aria-label="Ideal state, part by part"><thead><tr><th scope="col">Part</th><th scope="col">Ideal</th><th scope="col">Set up</th></tr></thead><tbody>${rows}</tbody></table>`);
}

// The best practice a tab is held to, from its ideals file: the summary, its
// parts as a table when the file has them, then the documents it rests on,
// folded into one closed line (count and newest date) that opens to the
// numbered list, each title a link with its date. A native details needs no script.
// name, escaped, names the region after its section, so a page with several
// ideal states has no two landmarks of one name (axe landmark-unique). level is
// its heading's: 2 where it opens a tab under the page's h1 (axe heading-order).
export function idealBlock(id, ideal, name, level = 3) {
  const h = `<h${level} id="${id}-ideal">Ideal state</h${level}>`;
  const label = name ? `aria-label="Ideal state: ${name}"` : `aria-labelledby="${id}-ideal"`;
  if (!ideal) return `<section class="ideal" ${label}>${h}<p class="empty">No ideal state written for this tab yet.</p></section>`;
  const refs = ideal.sources.map((s) => `<li><a href="${esc(s.url)}">${esc(s.title)}</a> <span class="small">${esc(s.date)}</span></li>`).join("");
  const n = ideal.sources.length;
  // Dates are YYYY-MM-DD, so the largest string is the newest.
  const newest = ideal.sources.reduce((a, s) => (s.date > a ? s.date : a), "");
  const fold = `<details class="refs-fold"><summary>${n} source${n === 1 ? "" : "s"}, newest ${esc(newest)}</summary><ol class="refs">${refs}</ol></details>`;
  return `<section class="ideal" ${label}>${h}<p>${esc(ideal.ideal)}</p>${partsTable(ideal.parts)}${fold}</section>`;
}

function panel(result, history, runs = [], ideal = null) {
  const { tab: id, quality, speed, consumption, rows, review } = result;
  const name = tabName(id);
  const split = review
    ? `<p class="small">metrics ${finite(quality.metricScore) ? quality.metricScore : "not measured"}, review ${review.score}</p>`
    : "";
  const gaps = GAP_TABS.has(id);
  const kinds = KIND_LIST.map((kind) => kindColumn(id, kind, rows.filter((r) => r.def.kind === kind), WEEKLY_TABS.has(id) ? runs : null, ideal));
  return `<section id="${id}" class="view tab" aria-labelledby="${id}-h" data-filter="all">
<header class="tab-head"><div class="th-name"><h2 id="${id}-h">${icon(id)}${esc(name)}</h2>${miniMassif(quality, speed)}</div>${scoreBlock("Quality", quality, split)}${scoreBlock("Speed", speed)}${scoreBlock("Consumption", consumption)}${trend(history, id, "quality")}${trend(history, id, "speed")}</header>
${idealBlock(id, ideal)}
${gaps ? gapList(rows) : ""}
${rows.filter((r) => FULL_WIDTH.has(r.def.chart)).map(flowFigure).join("")}
${reviewBlock(id, review, REPO, REVIEWS)}
${rows.length ? chips(rows) : ""}<div class="kinds two three">${kinds.join("")}</div>
</section>`;
}

// ---- Overview -------------------------------------------------------------------

function masterBlock(m) {
  return `<div class="total master"><p class="sb-l">Master score</p><p class="big">${glyph(scoreStatus(m.score))}${finite(m.score) ? m.score : "–"}<span class="small"> / 100</span></p>${meter(m.score, "Master score")}<p class="small">Quality, Speed and Consumption weigh a third each: each is the mean of the tabs scored in it, and the master is the mean of the ${m.categories} categories, over ${m.measured} measured tabs of ${m.total}. A tab is the mean of its categories. ${m.metricsMeasured} of ${m.metricsTotal} metrics measured; one not measured is shown, never scored as 0.</p></div>`;
}

function totalBlock(label, part) {
  return `<div class="total"><p class="sb-l">${label}</p><p class="big">${glyph(scoreStatus(part.score))}${finite(part.score) ? part.score : "–"}</p>${meter(part.score, `Overall ${label.toLowerCase()}`)}<p class="small">${part.measured} of ${part.total} tabs measured</p></div>`;
}

function scoreboard(results) {
  const cell = (p, label) =>
    `<td><span class="bd-n">${finite(p.score) ? p.score : "–"}</span>${meter(p.score, label)}<span class="small">${p.measured} of ${p.total}</span></td>`;
  const sortBtn = (key, label) => `<button type="button" data-sort="${key}">${label}</button>`;
  const body = results
    .map((r, i) => {
      const counts = statusCounts(r.rows);
      return `<tr data-order="${i}" data-q="${r.quality.score ?? ""}" data-s="${r.speed.score ?? ""}" data-m="${counts.misses}"><th scope="row"><a href="#${r.tab}">${icon(r.tab)}${esc(tabName(r.tab))}</a></th>${cell(r.quality, `${tabName(r.tab)} quality`)}${cell(r.speed, `${tabName(r.tab)} speed`)}<td><span class="bd-mix">${statusStack(counts, { legend: false, cls: "mini" })}<span class="bd-m">${counts.misses}</span></span></td><td class="num">${r.review ? r.review.score : "–"}</td></tr>`;
    })
    .join("");
  return scrollBox("Scores by tab", `<table class="board"><thead><tr><th scope="col" aria-sort="ascending">${sortBtn("order", "Tab")}</th><th scope="col">${sortBtn("q", "Quality")}</th><th scope="col">${sortBtn("s", "Speed")}</th><th scope="col">${sortBtn("m", "Misses")}</th><th scope="col">Review</th></tr></thead><tbody>${body}</tbody></table>`);
}

function fixList(results) {
  const queue = workQueue(results);
  if (!queue.length) return `<p class="empty">Every measured metric meets its goal.</p>`;
  return `<p class="small">Every metric near or missing its goal, across tabs and Quality, Speed and Consumption, ranked by the master points it adds when it meets its goal.</p><ol class="fix">${queue
    .map(
      (row) =>
        `<li>${tabChip(row.tab)}<a class="lbl" href="#m-${esc(row.def.id)}">${esc(row.def.label)}</a><span class="val">${esc(valueText(row))}</span>${bullet(row.def, row.entry.value)}<span class="goal">${esc(goalText(row.def))} · +${row.gain} points</span></li>`,
    )
    .join("")}</ol>`;
}

function notMeasuredList(results) {
  const rows = notMeasured(results);
  if (!rows.length) return "";
  return `<details class="nm"><summary><h3>Not measured</h3><b>${rows.length}</b></summary><ul>${rows
    .map(
      (row) =>
        `<li>${tabChip(row.tab)}<a href="#m-${esc(row.def.id)}">${esc(row.def.label)}</a><span class="reason">${esc(row.entry?.could_not_check ?? "No collector reported this metric.")}</span></li>`,
    )
    .join("")}</ul></details>`;
}

function overview(results, total) {
  const allRows = results.flatMap((r) => r.rows);
  const tabs = results.map((r) => ({ id: r.tab, name: tabName(r.tab), short: shortName(r.tab, tabName(r.tab)), icon: iconId(r.tab), quality: r.quality, speed: r.speed }));
  const key = `<p class="range-key"><span><svg viewBox="0 0 20 14" aria-hidden="true"><path class="r-q" d="M1 13 10 1l9 12z"/></svg>Front peak: quality</span><span><svg viewBox="0 0 20 14" aria-hidden="true"><path class="r-s" d="M1 13 10 1l9 12z"/></svg>Back peak: speed</span><span><svg viewBox="0 0 20 14" aria-hidden="true"><path class="r-q" d="M1 13 10 1l9 12z"/><path class="r-snow" d="M6.5 6 10 1l3.5 5z"/></svg>Snow: above 80</span></p>`;
  return `<section id="overview" class="view" aria-labelledby="overview-h">
<h2 id="overview-h" class="vh">Overview</h2>
<div class="totals">${masterBlock(total.master)}${totalBlock("Quality", total.quality)}${totalBlock("Speed", total.speed)}${total.consumption.total ? totalBlock("Consumption", total.consumption) : ""}<div class="total mix"><p class="sb-l">${allRows.length} metrics</p>${statusStack(statusCounts(allRows))}</div></div>
<h3>Work queue</h3>
${fixList(results)}
<div class="hero"><div class="range-box">${range(tabs)}</div>${key}</div>
<h3>Scoreboard</h3>
${scoreboard(results)}
${notMeasuredList(results)}
</section>`;
}

// ---- Page -----------------------------------------------------------------------

// The whole page: overview, one section per tab, and the client script.
export function render({ defs, metrics, reviews = {}, reviewHistory, history = [], tabs = DEFAULT_TABS, ideals = {}, meta = {}, css = "" }) {
  NAMES = new Map(tabs);
  REPO = meta.repoUrl ?? null;
  REVIEWS = meta.reviews ?? "quality/reviews";
  const allReviews = reviewHistory ?? Object.fromEntries(Object.entries(reviews).map(([tab, r]) => [tab, [r]]));
  const results = tabs.map(([tab]) => scoreTab(tab, defs, metrics, reviews));
  // Each run in the trend is scored with the reviews that existed by its date,
  // so the trend and the meter agree on the latest run.
  const scoredHistory = history.map((h) => {
    const date = h.generated_at?.slice(0, 10) ?? "";
    const then = newestReviews(allReviews, date);
    return { date, scores: Object.fromEntries(tabs.map(([tab]) => [tab, scoreTab(tab, defs, mergeMetrics(h), then)])) };
  });
  const total = overall(results);
  const commit = !meta.commit ? "unknown" : REPO ? `<a href="${esc(REPO)}/commit/${esc(meta.commit)}">${esc(meta.commit.slice(0, 7))}</a>` : esc(meta.commit.slice(0, 7));
  const legend = ["meets", "near", "misses", "not-measured"].map((s) => `<li>${glyph(s, "")}${STATUS_WORD[s]}</li>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<link rel="icon" href="data:,">
<title>Quality, Speed and Consumption${meta.name ? `: ${esc(meta.name)}` : ""}</title>
<script>if (!location.hash || location.hash === "#overview") document.documentElement.classList.add("rise");</script>
<style>
${tightCss(css)}
${PAGE_CSS}
</style>
<noscript><style>.heatmap:not(.all) tr.extra { display: table-row; }</style></noscript>
</head>
<body${REPO ? ` data-repo="${esc(REPO)}"` : ""}>
${SPRITE}
<header class="top">
<h1>Quality, Speed and Consumption</h1>
<p class="meta"><span>commit ${commit}</span><span>built ${esc(meta.builtAt ?? "")}</span></p>
<ul class="key" aria-label="Status key">${legend}</ul>
</header>
${nav(results, total)}
<main>
${overview(results, total)}
${results.map((r) => panel(r, scoredHistory, history, ideals[r.tab])).join("\n")}
</main>
<div id="tip" role="tooltip" hidden></div>
<script>
${CLIENT_JS}
</script>
</body>
</html>
`;
}
