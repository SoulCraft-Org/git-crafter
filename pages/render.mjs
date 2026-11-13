// Lays out Git Crafter's two pages, Process (index.html, three tabs: Build, CI
// and Testing) and Metrics and goals (metrics.html), from the model. Charts
// come from the Quality page's primitives in ../quality/render/, one copy
// for both pages (ci-flow.mjs draws every pipeline), and the Git Crafter drawings
// in draw.mjs; colors come from quality/render/tokens.css and page.css, then
// site.css.

import { bars, bullet, esc, finite, fmt, fmtCompact, glyph, meter, scoreStatus, spark, statusCounts, statusStack } from "../quality/render/charts.mjs";
import { SPRITE } from "../quality/render/icons.mjs";
import { COS_SPRITE, cicon, strip } from "./draw.mjs";
import { goalText, historySeries, isMeasured, outcomeHistory, rateGoals, repoScores } from "./model.mjs";
import { ciTab, testingTab } from "./ci-tab.mjs";
import { mapsTab } from "./maps-tab.mjs";
import { atLeast, ghRepo, ideal, repoBars, srcTip, val, when } from "./ui.mjs";


// What frames a page: its heading, its nav, the files its footer names, and
// the page a goal links to (none: a metric's name shows its source instead).
// Git Crafter's own; a repo's build passes its own (build.mjs PAGE_DEFAULTS).
const CHROME = {
  heading: "Git Crafter",
  nav: [
    { href: "index.html", page: "process", label: "Process", icon: "plan" },
    { href: "metrics.html", page: "metrics", label: "Metrics and goals", icon: "measure" },
  ],
  files: { data: "data/org.json", collector: "tools/collect_org.mjs", goals: "goals.json", process: "process.json" },
  metricsHref: "metrics.html",
};

function shell({ title, page, css, body, data, script, chrome = CHROME }) {
  const nav = chrome.nav
    .map((n) => `<a href="${esc(n.href)}"${n.page === page ? ' aria-current="page"' : ""}><span class="nl">${cicon(n.icon)}${esc(n.label)}</span></a>`)
    .join("");
  const n = data.repos.length;
  const f = chrome.files;
  const errs = data.errors?.length ? `<p class="small">Could not read: ${data.errors.map(esc).join("; ")}</p>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>${css}</style>
</head>
<body class="cos">
${SPRITE}${COS_SPRITE}
<header class="top"><h1>${esc(chrome.heading)}</h1><p class="meta"><span>${n} repo${n === 1 ? "" : "s"}</span>${data.site_read_at ? `<span>API data ${esc(when(data.generated_at))}</span><span>site data ${esc(when(data.site_read_at))}</span>` : `<span>data ${esc(when(data.generated_at))}</span>`}<span>built ${esc(when(data.built_at))}</span></p></header>
<nav aria-label="Pages">${nav}</nav>
<main class="${page}">
${body}
</main>
<footer class="foot">${errs}<p class="small">Data: <code>${esc(f.data)}</code>, written by <code>${esc(f.collector)}</code> with ${data.rest_calls !== undefined ? `${data.rest_calls} REST and ${data.graphql_calls} GraphQL calls` : `${data.gh_calls ?? "?"} gh calls`}. Goals: <code>${esc(f.goals)}</code>. Maps: <code>${esc(f.process)}</code>.</p></footer>
<div id="tip" role="tooltip" hidden></div>
<script>${script}</script>
</body>
</html>
`;
}

// The Process page's tabs, in order; process.json ideals is keyed by these.
export const PROCESS_TABS = ["build", "ci", "testing"];

// only: the tab ids a repo's config asks for, or null for every tab the docs
// allow. A tab its doc is missing for stays out either way. The maps tab
// keeps the id build, which configs and links already use.
export function renderProcess({ data, goalsDoc, processDoc, mapsDoc = null, defs = null, history = [], css, script, chrome = CHROME, tabs: only = null }) {
  const repos = data.repos.map((r) => r.name);
  const shows = (id) => !only || only.includes(id);
  const tabs = [
    ["build", "Maps", "plan"],
    ["ci", "CI", "ci"],
    ["testing", "Testing", "review"],
  ].filter(([id]) => shows(id));
  const draw = {
    build: () => mapsTab(data, goalsDoc, mapsDoc, defs, repos, chrome.metricsHref, history),
    ci: () => ciTab(data, repos, processDoc),
    testing: () => testingTab(data, repos),
  };
  const bar = `<div class="pbar-row"><div class="ptabs" role="group" aria-label="Process maps">${tabs
    .map(([id, name, icon], i) => `<a href="#tab=${id}" data-tab="${id}"${i === 0 ? ' aria-current="true"' : ""}>${cicon(icon)}${esc(name)}</a>`)
    .join("")}</div><label class="repo-pick">${cicon("repo")}<span class="vh">Repo</span><select id="prepo"><option value="">All repos</option>${repos.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join("")}</select></label></div>`;
  const body = `${bar}\n${tabs.map(([id, name]) => `<section class="ptab" id="tab-${id}" data-tab="${id}" aria-label="${esc(name)}">${ideal(`tab-${id}`, processDoc.ideals?.[id], name, 2)}${draw[id]()}</section>`).join("\n")}`;
  return shell({ title: `${chrome.heading}: Process`, page: "process", css, body, data, script, chrome });
}

// ---- Metrics and goals -------------------------------------------------------

function variants(g, draw) {
  const org = draw(g.value, g.status, "");
  if (!g.hasRepos) return org;
  return org + Object.entries(g.byRepo).map(([r, x]) => draw(x.value, x.status, r)).join("");
}

// The row's closed line: status glyph, label, value and bullet (each once for the org and once per repo), and the goal.
function goalSummary(g) {
  const e = g.entry;
  const tag = (html, r, status) => html.replace(/^<(\w+)/, `<$1 data-r="${esc(r)}"${status ? ` data-s="${status}"` : ""}${r ? " hidden" : ""}`);
  return `${variants(g, (v, s, r) => tag(glyph(s), r, s))}<span class="lbl">${esc(g.label)}</span>${variants(g, (v, s, r) =>
    tag(`<span class="val">${esc(finite(v) ? `${atLeast(e, r)}${fmtCompact(v, g.unit)}` : "–")}</span>`, r),
  )}${variants(g, (v, s, r) => tag(bullet(g, v), r))}<span class="goal">goal ${esc(goalText(g, fmtCompact))}</span>`;
}

// The charts under an open row: by repo, each read, and the breakdown.
function goalFigures(g, ctx) {
  const e = g.entry;
  const figs = [];
  const per = repoBars(e, ctx.repos);
  if (per.length) figs.push(`<figure class="d-fig"><figcaption>By repo</figcaption>${bars(per, g.unit)}</figure>`);
  const hs = spark(historySeries(ctx.history, g.metrics[0]), { label: `${g.label}, by read`, unit: g.unit, width: 240, height: 48 });
  if (hs) figs.push(`<figure class="d-fig"><figcaption>Each read</figcaption>${hs}</figure>`);
  if (e?.detail?.length) figs.push(`<figure class="d-fig"><figcaption>Breakdown</figcaption>${bars(e.detail, g.unit, { plain: e.detail.length > 6 })}</figure>`);
  return figs.join("");
}

// The goal's other metrics, listed under the rated one.
function alsoList(g, ctx) {
  const items = g.metrics
    .slice(1)
    .map((id) => {
      const s = ctx.metrics[id];
      return `<li><span tabindex="0" data-tip="${esc(srcTip(s))}">${esc(s?.label ?? id)}</span><b>${esc(val(s))}</b></li>`;
    })
    .join("");
  return items ? `<ul class="also">${items}</ul>` : "";
}

function goalRow(g, ctx) {
  const e = g.entry;
  const exact = isMeasured(e) && fmt(e.value, g.unit) !== fmtCompact(e.value, g.unit) ? `<p class="exact">${esc(`${atLeast(e)}${fmt(e.value, g.unit)}`)}</p>` : "";
  return `<details class="metric g-row s-${g.status}${g.hasRepos ? "" : " orgonly"}" id="goal-${esc(g.id)}" data-outcome="${esc(g.outcome)}" data-status="${g.status}" data-org-status="${g.status}">
<summary>${goalSummary(g)}</summary>
<div class="more">${exact}${isMeasured(e) ? "" : `<p class="reason">${esc(e?.could_not_check ?? "No collector reported this metric.")}</p>`}<div class="d-figs">${goalFigures(g, ctx)}</div>${alsoList(g, ctx)}<p class="src">Measured: ${esc(g.measured)}. ${esc(e?.source ?? "")}${e?.read_at ? ` <span class="read">read ${esc(when(e.read_at))}</span>` : ""}</p><p class="src">Goal: ${esc(g.goal_source)}</p></div>
</details>`;
}

function outcomeCard(o, hist) {
  const counts = statusCounts(o.goals);
  const h = spark(hist ?? [], { label: `${o.name} score by read`, width: 120, height: 34 });
  return `<button type="button" class="oc s-${o.status}" data-o="${esc(o.id)}" aria-pressed="false"><span class="oc-n">${cicon(o.icon)}${esc(o.name)}</span><span class="oc-s">${glyph(o.status)}<b>${finite(o.score) ? o.score : "–"}</b></span>${meter(o.score, `${o.name} score`)}${statusStack(counts, { legend: false, cls: "mini" })}${h}</button>`;
}

function compareTable(outcomes, repos, scores, org) {
  const cols = outcomes.flatMap((o) => o.goals.filter((g) => g.hasRepos));
  const head = `<tr><th scope="col"><button type="button" data-col="0" data-type="text">Repo</button></th><th scope="col" aria-sort="descending"><button type="button" data-col="1">Score</button></th>${cols
    .map((g, i) => `<th scope="col"><button type="button" data-col="${i + 2}" data-dir="${g.direction === "higher" ? -1 : 1}">${esc(g.label)}</button></th>`)
    .join("")}</tr>`;
  // Best score first, matching the header's aria-sort; unscored repos last.
  const rows = [...repos]
    .sort((a, b) => (scores[b].score ?? -1) - (scores[a].score ?? -1) || a.localeCompare(b))
    .map((r) => {
      const s = scores[r];
      const cells = cols
        .map((g) => {
          const x = g.byRepo[r];
          return `<td class="c s-${x.status}" data-v="${finite(x.value) ? x.value : ""}">${glyph(x.status, "")}${esc(finite(x.value) ? fmtCompact(x.value, g.unit) : "–")}</td>`;
        })
        .join("");
      return `<tr data-repo="${esc(r)}"><th scope="row" data-v="${esc(r)}"><a href="${esc(ghRepo(org, r))}">${cicon("repo")}${esc(r)}</a></th><td class="c s-${scoreStatus(s.score)}" data-v="${s.score ?? ""}">${meter(s.score, `${r} score`)}<b>${s.score ?? "–"}</b> <span class="small">${s.measured}/${s.total}</span></td>${cells}</tr>`;
    })
    .join("");
  return `<div class="scroll"><table class="cmp sortable"><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
}

// The Metrics page: outcome scores, history and each repo's scores.
export function renderMetrics({ data, goalsDoc, history, css, script, chrome = CHROME }) {
  const outcomes = rateGoals(goalsDoc, data);
  const repos = data.repos.map((r) => r.name);
  const scores = repoScores(outcomes, repos);
  const hist = outcomeHistory(goalsDoc, history);
  const allGoals = outcomes.flatMap((o) => o.goals);
  const counts = statusCounts(allGoals);
  const ctx = { repos, history, metrics: data.metrics };
  const chip = (f, label, n, pressed = false) => `<button type="button" data-f="${f}" aria-pressed="${pressed}">${f === "all" ? "" : glyph(f, "")}${label}<b data-n="${f}">${n}</b></button>`;
  const filters = `<div class="filters" hidden>
<div class="seg" role="group" aria-label="Outcome"><button type="button" data-o="all" aria-pressed="true">All outcomes</button>${outcomes.map((o) => `<button type="button" data-o="${esc(o.id)}" aria-pressed="false">${esc(o.name)}</button>`).join("")}</div>
<label class="repo-pick">${cicon("repo")}<span class="vh">Repo</span><select id="repo"><option value="">All repos</option>${repos.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join("")}</select></label>
<div class="chips" role="group" aria-label="Status">${chip("all", "All", allGoals.length, true)}${chip("misses", "Misses", counts.misses)}${chip("near", "Near", counts.near)}${chip("meets", "Meets", counts.meets)}${chip("not-measured", "Not measured", counts["not-measured"])}</div>
</div>`;
  const sections = outcomes
    .map(
      (o) =>
        `<section class="og" data-outcome="${esc(o.id)}" aria-labelledby="h-${esc(o.id)}"><h3 id="h-${esc(o.id)}">${cicon(o.icon)}${esc(o.name)}<span class="gchip s-${o.status}">${glyph(o.status, "")}${o.score ?? "–"}</span><span class="og-m">${esc(o.means)}</span>${o.site_link && data.site?.pages_url ? `<a class="og-m" href="${esc(data.site.pages_url)}">Site Quality page</a>` : ""}</h3>${ideal(`o-${o.id}`, o, o.name)}${o.goals.map((g) => goalRow(g, ctx)).join("\n")}</section>`,
    )
    .join("\n");
  const body = `<section class="hero stripbox" aria-labelledby="h-strip"><h2 id="h-strip" class="vh">Every goal against its target</h2><div class="strip-box">${strip(outcomes)}</div><div class="range-key">${statusStack(counts)}</div></section>
<section class="outcomes" aria-label="Outcome scores">${outcomes.map((o) => outcomeCard(o, hist[o.id])).join("")}</section>
${filters}
<div class="goals">${sections}</div>
<section class="repos" aria-labelledby="h-repos"><h3 id="h-repos">Repos against the same goals</h3>${compareTable(outcomes, repos, scores, data.org)}</section>`;
  return shell({ title: `${chrome.heading}: Metrics and goals`, page: "metrics", css, body, data, script, chrome });
}
