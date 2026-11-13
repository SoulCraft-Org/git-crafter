// The same-site crawl and reading level for the site collectors (site-lib.mjs).

import { join, resolve } from "node:path";
import { UA, firstLine, now, once } from "./site-base.mjs";
import { stripAll } from "../lib/strip.mjs";

// ---------- crawl ----------

const ENTITIES = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", "#38": "&", "#39": "'", "#x27": "'" };
// Text with its HTML entities for &, quotes, < and > decoded.
const decode = (s) => s.replace(/&(amp|quot|apos|lt|gt|#38|#39|#x27);/g, (_, e) => ENTITIES[e]);

// The links in a page's HTML as absolute URLs without their hash; mail, tel and script links left out.
export function extractLinks(html, pageUrl) {
  const links = new Set();
  const re = /<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const m of stripAll(html, /<!--[\s\S]*?-->/g).matchAll(re)) {
    const raw = decode((m[1] ?? m[2] ?? m[3] ?? "").trim());
    if (!raw || raw.startsWith("#") || /^(mailto|tel|sms|javascript|data):/i.test(raw)) continue;
    try {
      const u = new URL(raw, pageUrl);
      u.hash = "";
      links.add(u.href);
    } catch {
      // An unparseable href is not a link this crawl can follow.
    }
  }
  return [...links];
}

// How many same-site redirects one link may take before the crawl gives up.
const MAX_HOPS = 5;

// GETs a same-site URL and follows its redirects only while they stay on the
// site. A redirect off the site comes back as { away } and is never fetched: a
// short link that answers 302 to a sign-up form on another host is answered by
// that redirect, and the other host is not this site.
async function getOnSite(site, origin, start) {
  let at = new URL(start);
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const res = await site.fetch(at.href, {
      redirect: "manual",
      headers: { "user-agent": UA, accept: "text/html,*/*;q=0.8" },
      signal: AbortSignal.timeout(30_000),
    });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) return { res, at };
    await res.body?.cancel();
    const next = new URL(location, at);
    if (next.origin !== origin) return { away: { status: res.status, href: next.href } };
    at = next;
  }
  throw new Error(`more than ${MAX_HOPS} redirects`);
}

// Breadth first from "/", same origin only, GET only, at most `max` fetches.
// Query strings are dropped, so filters do not multiply pages. A path under a
// `skip` prefix (params.crawl_skip) is never fetched: an /api/ route can act
// on a GET (an unsubscribe link, say). A link that redirects off the site is
// answered by its redirect: `final` holds the other host's URL, and nothing
// there is fetched.
export function crawl(site, { max = 200, skip = [], concurrency = 4 } = {}) {
  return once(site, `crawl ${max} ${skip.join(" ")}`, async () => {
    const origin = new URL(site.origin).origin;
    const skipped = (path) => skip.some((s) => path.startsWith(s));
    const pages = new Map();
    const queue = ["/"];
    const seen = new Set(queue);
    let fetched = 0;
    const visit = async (path) => {
      try {
        const got = await getOnSite(site, origin, new URL(path, origin).href);
        if (got.away) {
          pages.set(path, { status: got.away.status, final: got.away.href, links: [] });
          return;
        }
        const { res, at } = got;
        const rec = { status: res.status, final: at.pathname, links: [] };
        if (res.ok && (res.headers.get("content-type") ?? "").includes("text/html")) {
          rec.links = extractLinks(await res.text(), at.href);
          for (const link of rec.links) {
            const u = new URL(link);
            if (u.origin !== origin || skipped(u.pathname) || seen.has(u.pathname)) continue;
            seen.add(u.pathname);
            queue.push(u.pathname);
          }
        } else {
          await res.body?.cancel();
        }
        pages.set(path, rec);
      } catch (e) {
        pages.set(path, { status: 0, error: firstLine(e), links: [] });
      }
    };
    while (queue.length && fetched < max) {
      const batch = queue.splice(0, Math.min(concurrency, max - fetched));
      fetched += batch.length;
      await Promise.all(batch.map(visit));
    }
    const root = pages.get("/");
    if (!root || root.status !== 200) {
      return { error: `GET / ${root?.error ?? `answered HTTP ${root?.status}`}` };
    }
    return { origin, pages, truncated: queue.length > 0, max, skip, read_at: now() };
  });
}

// Internal link targets that answered 4xx or 5xx, once per target, with the
// first page that links to it. Status 0 (timeout, network) is not counted
// here; the collector reports it as unverified.
export function brokenLinks({ origin, pages, skip = [] }) {
  const broken = new Map();
  for (const [from, rec] of pages) {
    for (const link of rec.links) {
      const u = new URL(link);
      if (u.origin !== origin || skip.some((s) => u.pathname.startsWith(s))) continue;
      const target = pages.get(u.pathname);
      if (target && target.status >= 400 && !broken.has(u.pathname)) {
        broken.set(u.pathname, { from, status: target.status });
      }
    }
  }
  return broken;
}

// Shortest clicks from "/" over the crawled link graph. A goal is an internal
// path (clicks to land on it) or an external href prefix (clicks to the page
// that links to it, plus the click on that link).
export function shortestClicks({ origin, pages }, goals) {
  const resolve = (path) => {
    const f = pages.get(path)?.final;
    return typeof f === "string" && f.startsWith("/") ? f : path;
  };
  const byFinal = new Map();
  for (const [path, rec] of pages) byFinal.set(resolve(path), rec);
  const dist = new Map([[resolve("/"), 0]]);
  const queue = [resolve("/")];
  while (queue.length) {
    const at = queue.shift();
    for (const link of byFinal.get(at)?.links ?? []) {
      const u = new URL(link);
      if (u.origin !== origin) continue;
      const next = resolve(u.pathname);
      if (!dist.has(next)) dist.set(next, dist.get(at) + 1), queue.push(next);
    }
  }
  return goals.map((goal) => {
    if (goal.path) return { ...goal, clicks: dist.get(resolve(goal.path)) ?? null };
    let best = null;
    for (const [path, d] of dist) {
      if (byFinal.get(path)?.links.some((l) => l.startsWith(goal.href)) && (best === null || d + 1 < best)) best = d + 1;
    }
    return { ...goal, clicks: best };
  });
}

// The route a visitor clicks to reach a goal, found the way shortestClicks
// counts clicks: each hop is { from, link, to }, the page clicked on, the link
// that leads on and the page it lands on (null when it leaves the site). An
// external goal ends at the nearest page linking it. null when the crawl
// reached no route.
export function taskRoute({ origin, pages }, goal) {
  const resolve = (path) => {
    const f = pages.get(path)?.final;
    return typeof f === "string" && f.startsWith("/") ? f : path;
  };
  const byFinal = new Map();
  for (const [path, rec] of pages) byFinal.set(resolve(path), rec);
  const parent = clickParents({ origin, pages, byFinal, resolve });
  const hopsTo = (path) => {
    const hops = [];
    for (let hop = parent.get(path); hop; hop = parent.get(hop.from)) hops.unshift(hop);
    return hops;
  };
  if (goal.path) return parent.has(resolve(goal.path)) ? hopsTo(resolve(goal.path)) : null;
  // Breadth-first order: the first page linking the goal is the nearest.
  for (const path of parent.keys()) {
    const link = byFinal.get(path)?.links.find((l) => l.startsWith(goal.href));
    if (link) return [...hopsTo(path), { from: path, link, to: null }];
  }
  return null;
}

// Breadth-first from the home page: each page's first hop, { from, link, to }.
function clickParents({ origin, pages, byFinal, resolve }) {
  const parent = new Map([[resolve("/"), null]]);
  const queue = [resolve("/")];
  while (queue.length) {
    const at = queue.shift();
    for (const link of byFinal.get(at)?.links ?? []) {
      const u = new URL(link);
      if (u.origin !== origin) continue;
      const next = resolve(u.pathname);
      const away = /^https?:/.test(pages.get(u.pathname)?.final ?? "");
      if (!parent.has(next)) parent.set(next, { from: at, link, to: away ? null : next }), queue.push(next);
    }
  }
  return parent;
}

// ---------- reading ----------

// A word's syllables by a vowel-group count, at least 1.
export function syllables(word) {
  let w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 1; // a number or symbol still costs the reader a beat
  if (w.length <= 3) return 1;
  w = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "");
  return Math.max(1, w.match(/[aeiouy]{1,2}/g)?.length ?? 0);
}

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu;
// The words in text.
const countWords = (s) => s.match(WORD)?.length ?? 0;

// innerText puts each block on its own line. A line is prose when it ends in
// sentence punctuation; headings, buttons and nav labels do not, and a
// readability formula built for prose would read them as short sentences.
// A sentence over `longWords` words is long (params.long_sentence_words).
export function readingStats(text, longWords = 30) {
  const sentences = [];
  for (const line of text.split(/\n+/).map((l) => l.trim())) {
    if (!/[.!?:]["'”’)]*$/.test(line)) continue;
    for (const s of line.split(/(?<=[.!?])["'”’)]*\s+(?=["'“‘(]?[\p{Lu}\p{N}])/u)) {
      const words = s.match(WORD) ?? [];
      if (words.length) sentences.push({ text: s, words: words.length, syllables: words.reduce((n, w) => n + syllables(w), 0) });
    }
  }
  if (!sentences.length) return { sentences: 0, words: 0, grade: null, long: [] };
  const words = sentences.reduce((n, s) => n + s.words, 0);
  const syl = sentences.reduce((n, s) => n + s.syllables, 0);
  // Flesch-Kincaid grade level (Kincaid et al., 1975).
  const grade = 0.39 * (words / sentences.length) + 11.8 * (syl / words) - 15.59;
  return { sentences: sentences.length, words, grade: Math.round(grade * 10) / 10, long: sentences.filter((s) => s.words > longWords) };
}
