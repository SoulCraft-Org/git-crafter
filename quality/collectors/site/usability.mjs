// Usability tab, measured half: how easy the site is to understand, read and
// move through (reading grade, long sentences, axe, labels, broken links), and
// how fast a visitor finishes a task (clicks, words before the first action,
// TBT), and the data a visitor downloads to finish one (the heaviest form
// page). A review file supplies the judgment scores. Reads go through
// site-lib.mjs, which the design collector shares.
//
// The site, its key and form pages, its tasks and the crawl's limits are
// params of quality/targets/usability.json; a repo with no site gets
// could_not_check.

import { readFileSync } from "node:fs";
import {
  audit,
  brokenLinks,
  couldNotCheck,
  crawl,
  forms,
  keyboardPass,
  MAX_TABS,
  measured,
  okPages,
  readingStats,
  shortestClicks,
  siteFor,
  taskRoute,
  toDetail,
  vitalsMetric,
  vitalsPages,
} from "./site-lib.mjs";

export const area = "usability";
const TARGETS = JSON.parse(readFileSync(new URL("../../targets/usability.json", import.meta.url), "utf8"));
export const PARAMS = Object.assign({}, ...TARGETS.map((t) => t.params ?? {}));
const IDS = TARGETS.map((t) => t.id);
// Rules with a metric of their own: contrast is the design tab's.
const OWN_METRIC = new Set(["color-contrast", "color-contrast-enhanced", "target-size"]);
// A viewport narrower than this is a phone, as in site-lib's audit.
const PHONE = 768;

const list = (x) => (Array.isArray(x) ? x : []);

// Every Usability metric, from the site's pages in a browser.
export async function collect({ root, mode, params = PARAMS, site = siteFor(params, root) } = {}) {
  void mode; // CI and local read the same sources.
  if (site.error) return Object.fromEntries(IDS.map((id) => [id, couldNotCheck(site.error, "params.origin or params.site_dir")]));
  const pages = list(params.key_pages);
  const widths = list(params.widths);
  const formPages = list(params.form_pages);
  const max = Number(params.crawl_max) > 0 ? Number(params.crawl_max) : 200;
  const skip = list(params.crawl_skip);
  const [run, formRun, links, vitals] = await Promise.all([
    audit(site, { pages, widths }, root),
    formPages.length ? forms(site, formPages) : null,
    crawl(site, { max, skip }),
    vitalsPages(site, pages),
  ]);
  const auditSource = `Playwright (Chrome) on ${site.origin}`;
  const crawlSource = `GET crawl of ${site.origin} from /, same origin, at most ${max} fetches${skip.length ? `, ${skip.join(" and ")} skipped` : ""}`;
  const tasks = list(params.tasks);
  return {
    ...fromAudit(run, { pages, widths, longWords: Number(params.long_sentence_words) || 30, source: auditSource }),
    ...fromForms(formRun, formPages, auditSource),
    ...fromCrawl(links, tasks, crawlSource),
    "usability.keyboard_task_share": await keyboardShare(site, links, tasks, auditSource),
    "usability.tbt_mobile": vitalsMetric(vitals, pages.length, (r) => Math.round(r.tbt_ms), (r) => (r.blocking ? `; blocking: ${r.blocking.join("; ")}` : "")),
  };
}

const AUDIT_IDS = ["reading_grade", "long_sentences", "words_before_action", "axe_violations", "target_size_375"].map((id) => `usability.${id}`);

function fromAudit(run, { pages, widths, longWords, source }) {
  if (run.error) return Object.fromEntries(AUDIT_IDS.map((id) => [id, couldNotCheck(run.error, source)]));
  const axe = `axe-core${run.axe ? ` ${run.axe}` : ""}`;
  return {
    ...readingMetrics(run, { pages, desk: Math.max(...widths), longWords, source }),
    "usability.axe_violations": axeMetric(run, { widths, source, axe }),
    "usability.target_size_375": targetMetric(run, { pages, phoneWidth: Math.min(...widths), source, axe }),
  };
}

// Reading: main text, prose lines only (see readingStats).
function readingMetrics(run, { pages, desk, longWords, source }) {
  const deskPages = okPages(pages.map((p) => [p, run.pages[`${p}@${desk}`]]));
  const atDesk = `${source}, key pages at ${desk} px`;
  if (!deskPages.ok.length) {
    return Object.fromEntries(AUDIT_IDS.slice(0, 3).map((id) => [id, couldNotCheck(`no key page loaded${deskPages.note}`, atDesk)]));
  }
  const stats = deskPages.ok.map(([path, r]) => [path, readingStats(r.facts.mainText, longWords), r.facts]);
  const graded = stats.filter(([, s]) => s.grade !== null);
  const noProse = stats.filter(([, s]) => s.grade === null).map(([p]) => p);
  const proseNote = noProse.length ? `; no prose on ${noProse.join(", ")}` : "";
  const words = stats.map(([label, , f]) => ({ label: f.firstAction ? label : `${label} (no link or button)`, value: f.wordsBeforeAction }));
  return {
    "usability.reading_grade": graded.length
      ? measured(
          Math.max(...graded.map(([, s]) => s.grade)),
          `${atDesk}: Flesch-Kincaid grade of the main element's prose (lines ending in sentence punctuation); value is the hardest page${deskPages.note}${proseNote}`,
          graded.map(([label, s]) => ({ label, value: s.grade })),
          run.read_at,
        )
      : couldNotCheck(`no key page has prose in main${deskPages.note}`, atDesk),
    "usability.long_sentences": measured(
      stats.reduce((n, [, s]) => n + s.long.length, 0),
      `${atDesk}: sentences over ${longWords} words (params.long_sentence_words) in the main element's prose${deskPages.note}`,
      stats.map(([label, s]) => ({ label, value: s.long.length })),
      run.read_at,
    ),
    "usability.words_before_action": measured(
      Math.max(...words.map((d) => d.value)),
      `${atDesk}: visible words in main before its first visible link, button or field; value is the wordiest page${deskPages.note}`,
      words,
      run.read_at,
    ),
  };
}

// axe, every rule but the ones with a metric of their own, once per element
// across every width.
function axeMetric(run, { widths, source, axe }) {
  const both = okPages(Object.entries(run.pages));
  if (!both.ok.length) return couldNotCheck(`no key page loaded${both.note}`, source);
  const seen = new Set();
  const byRule = new Map();
  const first = new Map();
  for (const [key, r] of both.ok) {
    for (const v of r.violations.filter((v) => !OWN_METRIC.has(v.id))) {
      for (const t of v.targets) {
        const id = `${key.split("@")[0]} ${v.id} ${t}`;
        if (seen.has(id)) continue;
        seen.add(id);
        byRule.set(v.id, (byRule.get(v.id) ?? 0) + 1);
        if (!first.has(v.id)) first.set(v.id, `${t} on ${key.split("@")[0]}`);
      }
    }
  }
  return measured(
    seen.size,
    `${source}, key pages at ${widths.join(" and ")} px: ${axe} default rules except color-contrast and target-size, distinct failing elements; detail is by rule, with its first failing element${both.note}`,
    toDetail(byRule).map((d) => ({ ...d, label: `${d.label} (first: ${first.get(d.label)})` })),
    run.read_at,
  );
}

function targetMetric(run, { pages, phoneWidth, source, axe }) {
  if (!(phoneWidth < PHONE)) return couldNotCheck(`params.widths has no phone width under ${PHONE} px`, "params.widths");
  const phone = okPages(pages.map((p) => [p, run.pages[`${p}@${phoneWidth}`]]));
  if (!phone.ok.length) return couldNotCheck(`no key page loaded at ${phoneWidth} px${phone.note}`, source);
  const detail = phone.ok.map(([path, r]) => {
    const targets = [...new Set(r.violations.find((v) => v.id === "target-size")?.targets ?? [])];
    return { label: targets.length ? `${path} (${targets.slice(0, 6).join(", ")})` : path, value: targets.length };
  });
  return measured(
    detail.reduce((n, d) => n + d.value, 0),
    `${source}, key pages at ${phoneWidth} px: ${axe} target-size (WCAG 2.2 SC 2.5.8, 24 px), switched on; failing elements${phone.note}`,
    detail,
    run.read_at,
  );
}

// Forms are where most tasks finish: their fields' labels (quality) and the
// data a visitor downloads to open one (consumption). The key pages' bytes
// are the Design tab's, so no page is counted twice.
function fromForms(run, paths, source) {
  const ids = ["usability.unlabeled_fields", "usability.form_page_kib"];
  const all = (reason, from) => Object.fromEntries(ids.map((id) => [id, couldNotCheck(reason, from)]));
  if (!run) return all("params.form_pages names no form page", "params.form_pages");
  if (run.error) return all(run.error, source);
  const forms = okPages(paths.map((p) => [p, run.forms?.[p]]));
  if (!forms.ok.length) return all(`no form page loaded${forms.note}`, source);
  const detail = forms.ok.map(([label, r]) => ({ label, value: r.fields.filter((f) => !f.labeled).length }));
  const kib = forms.ok.filter(([, r]) => Number.isFinite(r.bytes?.total)).map(([label, r]) => ({ label, value: Math.round((r.bytes.total / 1024) * 10) / 10 }));
  return {
    [ids[0]]: measured(
      detail.reduce((n, d) => n + d.value, 0),
      `${source}, form pages loaded and never submitted: visible fields with no label, aria-label, aria-labelledby or title (a placeholder alone does not count)${forms.note}`,
      detail,
      run.read_at,
    ),
    [ids[1]]: kib.length
      ? measured(
          Math.max(...kib.map((d) => d.value)),
          `${source}, form pages at 1280 px, fresh context: all response bytes (body plus headers) to the load event plus network idle; value is the heaviest form page${forms.note}`,
          kib,
          run.read_at,
        )
      : couldNotCheck(`no loaded form page reported its bytes${forms.note}`, source),
  };
}

// params.tasks: [{ label, path }] or [{ label, goals: [{ path } | { href, via? }] }].
// A task with several goals takes whichever is fewest clicks from /, the first
// listed on a tie, and its detail label names the goal that won.
const via = (g) => g.via ?? g.path ?? g.href;
function taskClicks(links, task) {
  const goals = task.goals ?? (task.path ? [{ path: task.path }] : []);
  const best = shortestClicks(links, goals)
    .filter((g) => g.clicks !== null)
    .sort((a, b) => a.clicks - b.clicks)[0];
  const label = best && goals.length > 1 ? `${task.label} (via ${via(best)})` : task.label;
  return { label, clicks: best?.clicks ?? null, goals };
}

// A task done by keyboard alone (WCAG 2.2 SC 2.1.1 Keyboard): on each page of
// its shortest route, Tab reaches the link that leads on and Enter follows it
// to the route's next page. A multi-goal task takes its shortest route, as its
// clicks do. A task the pass could not read is named and left out, never 0.
async function keyboardShare(site, links, tasks, auditSource) {
  const source = `${auditSource}, 1280 px: each task's shortest route from / in the crawl, followed by Tab and Enter from a fresh load`;
  if (!tasks.length) return couldNotCheck("params.tasks names no task", "params.tasks");
  if (links.error) return couldNotCheck(links.error, source);
  const routes = tasks.map((t) => {
    const goals = t.goals ?? (t.path ? [{ path: t.path }] : []);
    const found = goals.map((g) => taskRoute(links, g)).filter(Boolean).sort((a, b) => a.length - b.length)[0];
    return { label: t.label, hops: found ?? null };
  });
  const reached = routes.filter((r) => r.hops?.length);
  const notes = routes.filter((r) => !r.hops?.length).map((r) => `${r.label} (no route from / in the crawl)`);
  if (!reached.length) return couldNotCheck(`no task's route was reached from / in the crawl`, source);
  const run = await keyboardPass(site, reached);
  if (run.error) return couldNotCheck(run.error, source);
  const short = (link) => link.replace(site.origin, "");
  const detail = [];
  reached.forEach((r, i) => {
    const got = run.tasks?.[i] ?? { status: "error", error: "no result" };
    const hop = r.hops[got.hop] ?? {};
    if (got.status === "done") detail.push({ label: r.label, value: 1, unit: "" });
    else if (got.status === "missed") detail.push({ label: `${r.label} (Tab never reaches ${short(hop.link)} on ${hop.from})`, value: 0, unit: "" });
    else if (got.status === "wrong") detail.push({ label: `${r.label} (Enter on ${short(hop.link)} lands on ${got.landed}, not ${hop.to})`, value: 0, unit: "" });
    else if (got.status === "capped") notes.push(`${r.label} (${MAX_TABS} Tab presses on ${hop.from} without reaching ${short(hop.link)})`);
    else notes.push(`${r.label} (${got.error})`);
  });
  const note = notes.length ? `; not counted: ${notes.join("; ")}` : "";
  if (!detail.length) return couldNotCheck(`no task could be read${note}`, source);
  return measured(Math.round((1000 * detail.filter((d) => d.value).length) / detail.length) / 10, `${source}${note}`, detail, run.read_at);
}

function fromCrawl(links, tasks, source) {
  if (links.error) {
    const reason = `${links.error}; check the site is up and the network reachable`;
    return { "usability.broken_links": couldNotCheck(reason, source), "usability.task_clicks": couldNotCheck(reason, source) };
  }
  const out = {};
  const scope = `${links.pages.size} fetched${links.truncated ? `, stopped at the ${links.max} limit with pages left unvisited` : ", every reachable page"}`;
  const unverified = [...links.pages].filter(([, r]) => r.status === 0).map(([p, r]) => `${p} (${r.error})`);
  // A same-site link that redirects off the site (a short link to a sign-up
  // form) answered with its redirect. The crawl never fetches the other host,
  // and a target whose answer came from another host never counts.
  const offSite = (path) => {
    const final = links.pages.get(path)?.final;
    return typeof final === "string" && !final.startsWith("/");
  };
  const broken = new Map([...brokenLinks(links)].filter(([target]) => !offSite(target)));
  out["usability.broken_links"] = measured(
    broken.size,
    `${source} (${scope}): internal link targets answering 4xx or 5xx, once per target; a target that redirects off the site counts as answered, whatever the other host says; detail label is target ← first page linking it` +
      (unverified.length ? `; unverified (no answer): ${unverified.join(", ")}` : ""),
    [...broken].map(([target, b]) => ({ label: `${target} ← ${b.from}`, value: b.status, unit: "HTTP status" })),
    links.read_at,
  );

  const taskSource = `${source}: shortest path from / in the crawled link graph to each of params.tasks; an external goal adds the click on its link; a task with several goals takes the fewest clicks; value is the longest task`;
  if (!tasks.length) {
    out["usability.task_clicks"] = couldNotCheck("params.tasks names no task", "params.tasks");
    return out;
  }
  const clicks = tasks.map((t) => taskClicks(links, t));
  const unreached = clicks
    .filter((c) => c.clicks === null)
    .map((c) => `${c.label}: no link to ${c.goals.map(via).join(" or ") || "any goal"} reached from / (${scope})`);
  out["usability.task_clicks"] = unreached.length
    ? couldNotCheck(`${unreached.join("; ")}. A static crawl cannot prove there is no path, so find the link or raise params.crawl_max`, taskSource)
    : measured(
        Math.max(...clicks.map((c) => c.clicks)),
        taskSource,
        clicks.map((c) => ({ label: c.label, value: c.clicks })),
        links.read_at,
      );
  return out;
}
