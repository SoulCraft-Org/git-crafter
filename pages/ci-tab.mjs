// The CI and Testing tabs: each repo's pipeline as a flow of its workflows,
// and its test suites with the site's pyramid of cases.

import { esc, finite, fmt, glyph, statusCounts, statusStack } from "../quality/render/charts.mjs";
import { ciFlow, passStatus } from "../quality/render/ci-flow.mjs";
import { cicon } from "./draw.mjs";
import { isMeasured } from "./model.mjs";
import { entryOf, mtile, siteError, when } from "./ui.mjs";

// The site repo whose Quality data the collector copied (data.site.repo,
// "org/name"): its sections open first and carry its test pyramid.
const siteName = (data) => data.site?.repo?.split("/").pop() ?? null;

// One repo's section in the CI and Testing tabs; the repo filter shows one.
const repoSection = (r, open, summary, body) =>
  `<details class="repo-sec" data-repo="${esc(r)}"${open ? " open" : ""}><summary><span class="rs-n">${cicon("repo")}${esc(r)}</span>${summary}</summary>${body}</details>`;
const srcLine = (x) => `<p class="src">${esc(x.source ?? "")}${x.read_at ? ` <span class="read">read ${esc(when(x.read_at))}</span>` : ""}</p>`;

const NO_FILES = `<p class="reason">not measured: data/org.json has no workflow data yet; a session runs node tools/collect_org.mjs</p>`;

// The CI standard (process.json ci.metrics): one tile per metric, before each
// repo's pipeline.
function ciStandard(data, processDoc) {
  const c = processDoc?.ci;
  if (!c?.metrics?.length) return "";
  const m = new Proxy({}, { get: (_, id) => entryOf(data, id) });
  const src = c.source ? `<p class="src"><a href="${esc(/^https:\/\//.test(c.source) ? c.source : `${processDoc.repo_url}/${c.source}`)}">${esc(c.source)}</a></p>` : "";
  return `<section aria-label="The CI standard"><h3 class="ch">${cicon("ci")}The CI standard</h3><div class="mts">${c.metrics.map((id) => mtile(m[id], id)).join("")}</div>${src}</section>`;
}

// The note under the site's pipeline when its own flow was not read.
// The ci.flow fallback goes once the site reports ci.latest_flow, with tools/collect_org.mjs's and tests/pages-collect.test.mjs's finishCollect test.
function flowNote(r, data) {
  const read = data.metrics?.["site.ci.latest_flow"] ?? data.metrics?.["site.ci.flow"];
  if (r !== siteName(data) || read || !siteError(data)) return "";
  return `<p class="reason">The site's own pipeline flow was not read (${esc(siteError(data))}); this pipeline is read from its workflow files.</p>`;
}

// Workflows that run only on demand, on a schedule or on a comment are
// not on the path to deploy, so they get a flow of their own.
const apartFlow = (p, r) => (p.apart?.length ? `<h4 class="apart-h">${cicon("clock")}Apart from the pipeline</h4>${ciFlow(p.apart, { id: `ci-${r}-apart`, label: `${r}, workflows apart from the pipeline` })}` : "");

// One repo's section in the CI tab.
function ciRepo(r, data) {
  const p = data.pipelines?.[r];
  if (!p) return "";
  if (p.could_not_check) return repoSection(r, false, `<span class="small">not read</span>`, `<p class="reason">${esc(p.could_not_check)}</p>${srcLine(p)}`);
  const wf = [...p.detail, ...(p.apart ?? [])].filter((d) => d.kind === "workflow");
  const counts = statusCounts(wf.map((d) => ({ status: passStatus(d.pass_rate) })));
  const files = new Set(wf.map((d) => d.file)).size;
  const summary = `<span class="small">${files} workflow${files === 1 ? "" : "s"}</span>${statusStack(counts, { legend: false, cls: "mini" })}`;
  return repoSection(r, r === siteName(data), summary, `${flowNote(r, data)}${ciFlow(p.detail, { id: `ci-${r}`, label: `${r} pipeline` })}${apartFlow(p, r)}${srcLine(p)}`);
}

// The CI tab: the CI standard's tiles, then each repo's pipeline.
export function ciTab(data, repos, processDoc) {
  const head = ciStandard(data, processDoc);
  if (!data.pipelines) return head + NO_FILES;
  return head + repos.map((r) => ciRepo(r, data)).join("");
}

// The site's code suites, bottom of the pyramid first, as its Tests tab
// counts them (site.tests.cases), each with the CI job its metric ids name:
// e2e for the end-to-end suite, site-tests for the rest.
function pyramid(m, t) {
  const cases = m["site.tests.cases"];
  if (!isMeasured(cases) || !cases.detail?.length) return "";
  const max = Math.max(...cases.detail.map((d) => d.value));
  const e2e = (label) => /end to end|e2e/i.test(label);
  const timeOf = (label) => m[e2e(label) ? "site.tests.e2e_shard_p50" : "site.tests.site_tests_p50"];
  const e2eRow = t.rows.find((x) => /e2e/i.test(x.suite));
  const passOf = (label) => (e2e(label) ? { value: e2eRow?.pass_rate, source: t.source, read_at: t.read_at } : m["site.tests.main_pass_rate"]);
  const dispatchOf = (label) => {
    const l = label.toLowerCase();
    const hit = t.dispatch.filter((d) => /^test:/.test(d) && (l.includes(d.slice(5)) || (d === "test:e2e" && e2e(label))));
    return hit.sort((a, b) => b.length - a.length)[0];
  };
  const routes = isMeasured(m["site.tests.e2e_routes"]) ? `${m["site.tests.e2e_routes"].value}% of routes opened, ${m["site.tests.axe_routes"]?.value ?? "–"}% checked with axe` : "";
  const rows = [...cases.detail]
    .reverse()
    .map((d) => {
      const [name, files] = String(d.label).split(/,\s*/);
      const tm = timeOf(d.label);
      const ps = passOf(d.label);
      const tip = `${d.label}: ${d.value} cases; ${cases.source}; read ${when(cases.read_at)}`;
      return `<li data-tip="${esc(tip)}" tabindex="0"><span class="py-l">${esc(name)}</span><span class="py-bar"><i style="width:${((d.value / max) * 100).toFixed(1)}%"></i></span><span class="py-n">${esc(fmt(d.value))}</span><span class="py-meta"><span>${esc(files ?? "")}</span><span>${esc(e2e(d.label) ? "CI job e2e" : "CI job site-tests")}${dispatchOf(d.label) ? `, or cloud-test ${esc(dispatchOf(d.label))}` : ""}</span><span>${esc(isMeasured(tm) ? `${tm.value} min` : "not timed")}</span><span>${glyph(passStatus(ps?.value))}${esc(finite(ps?.value) ? `${ps.value}% pass` : "pass not measured")}</span>${e2e(d.label) && routes ? `<span>${esc(routes)}</span>` : ""}</span></li>`;
    })
    .join("");
  return `<figure class="pyr"><figcaption>Test cases by suite, the pyramid's base at the bottom</figcaption><ol class="py">${rows}</ol>${srcLine(cases)}</figure>`;
}

// A test job named like its workflow (secret-scan under secret-scan) adds
// nothing the workflow row does not say, so it gets no row of its own.
const jobsOf = (x) => (x.jobs ?? []).filter((j) => j.name !== x.suite);

const jobRow = (j) =>
  `<tr class="job"><th scope="row">${esc(j.name)}</th><td>${esc(j.when)}</td><td>${esc(j.checks)}</td><td class="num" data-tip="jobs are not timed apart; the workflow row above has its runs" tabindex="0">–</td><td class="num">–</td></tr>`;

const suiteRow = (x) =>
  `<tr><th scope="row" data-tip="${esc(x.file)}" tabindex="0">${esc(x.suite)}</th><td>${esc(x.when)}</td><td>${esc(x.checks)}</td><td class="num">${esc(finite(x.value) ? `${x.value} min` : "not timed")}</td><td class="num">${glyph(passStatus(x.pass_rate))}${esc(finite(x.pass_rate) ? `${x.pass_rate}%` : "not measured")}</td></tr>${jobsOf(x).map(jobRow).join("")}`;

// The suites table, or that no workflow is named for tests.
function suitesTable(t) {
  if (!t.rows.length) return `<p class="empty">No workflow named for tests.</p>`;
  const head = `<tr><th scope="col">Suite</th><th scope="col">When</th><th scope="col">Checks</th><th scope="col" class="num">Median</th><th scope="col" class="num">Pass</th></tr>`;
  return `<div class="scroll"><table class="suites"><thead>${head}</thead><tbody>${t.rows.map(suiteRow).join("")}</tbody></table></div>`;
}

// One repo's section in the Testing tab.
function testingRepo(r, data) {
  const t = data.testing?.[r];
  if (!t) return "";
  if (t.could_not_check) return repoSection(r, false, `<span class="small">not read</span>`, `<p class="reason">${esc(t.could_not_check)}</p>`);
  const m = data.metrics;
  const dispatch = t.dispatch.length ? `<p class="disp"><b>cloud-test</b> ${t.dispatch.map((d) => `<code>${esc(d)}</code>`).join(" ")}</p>` : "";
  const counts = statusCounts(t.rows.map((x) => ({ status: passStatus(x.pass_rate) })));
  const suites = t.rows.reduce((n, x) => n + Math.max(jobsOf(x).length, 1), 0);
  const site = r === siteName(data);
  const cases = site && isMeasured(m["site.tests.cases"]) ? `, ${fmt(m["site.tests.cases"].value)} cases` : "";
  const summary = `<span class="small">${suites} suite${suites === 1 ? "" : "s"}${cases}</span>${statusStack(counts, { legend: false, cls: "mini" })}`;
  return repoSection(r, site, summary, `${site ? sitePyramid(data, t) : ""}${suitesTable(t)}${dispatch}${srcLine(t)}`);
}

// The site's pyramid of test cases, or why it is not measured.
function sitePyramid(data, t) {
  const cases = entryOf(data, "site.tests.cases");
  return isMeasured(cases) ? pyramid(data.metrics, t) : `<p class="reason">Test cases by suite: not measured: ${esc(cases?.could_not_check ?? "the site's data has no tests.cases")}</p>`;
}

// The Testing tab: each repo's suites, the site's with its pyramid.
export function testingTab(data, repos) {
  if (!data.testing) return NO_FILES;
  return `<p class="mac">${cicon("ci")}No suite runs on a local machine. A session dispatches one to <code>cloud-test</code>.</p>${repos.map((r) => testingRepo(r, data)).join("")}`;
}
