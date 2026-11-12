// node --test quality/collectors/site/usability.test.mjs
// Known-good fixture values are worked out by hand from
// quality/fixtures/usability/; the comments beside each expectation say how.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { area, collect, PARAMS } from "./usability.mjs";
import {
  PSI_ENDPOINT,
  brokenLinks,
  crawl,
  extractLinks,
  formFields,
  keyboardPass,
  labVitals,
  launchChrome,
  readingStats,
  runAxe,
  siteFor,
  syllables,
  taskRoute,
  tbtFromTasks,
} from "./site-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "..", "fixtures", "usability");
const targets = JSON.parse(readFileSync(join(here, "..", "..", "targets", "usability.json"), "utf8"));
const json = (file) => JSON.parse(readFileSync(join(fixtures, file), "utf8"));
const root = mkdtempSync(join(tmpdir(), "usability-root-"));

// The fixture site's override over the template's params: six key pages,
// four form pages and six tasks. Joining the chat has three goals: the /chat/
// short link (with or without its slash), or the off-site form it leads to.
const CHAT = { label: "Join the chat", goals: [{ path: "/chat/" }, { path: "/chat" }, { href: "https://forms.example/chat-invite", via: "the form link" }] };
const FIXTURE = {
  ...PARAMS,
  key_pages: ["/", "/directory/", "/rankings/", "/places/", "/people/", "/join/"],
  form_pages: ["/join/apply/", "/rankings/nominate/", "/directory/suggest/", "/newsletter/"],
  tasks: [
    CHAT,
    { label: "Find resources", path: "/directory/" },
    { label: "Nominate a company", path: "/rankings/nominate/" },
    { label: "Apply for a seat", path: "/join/apply/" },
    { label: "Subscribe", path: "/newsletter/" },
    { label: "Privacy policy", path: "/privacy/" },
  ],
};
const run = (site, params = FIXTURE) => collect({ root, mode: "ci", params, site });

function psiResponse(entry) {
  if (!entry) return new Response("{}", { status: 404 });
  if (entry.status) return new Response('{"error":{}}', { status: entry.status });
  return Response.json({
    lighthouseResult: {
      audits: {
        "largest-contentful-paint": { numericValue: entry.lcp_ms },
        "cumulative-layout-shift": { numericValue: entry.cls },
        "total-blocking-time": { numericValue: entry.tbt_ms },
      },
    },
  });
}

// Serves quality/fixtures/usability/site/ as https://fixture.test and records
// every URL asked for, so the test can check what the crawl never fetches.
// `pages` swaps a path's file for another fixture: a home page that links the
// /chat/ short link, or a links page with no chat link at all. `keyboard`
// maps a link to what the keyboard pass found at it (missed, wrong, capped or
// error); every other hop is followed.
function fixtureSite({ audit = json("audit.json"), pages = {}, keyboard = {} } = {}) {
  const routes = json("routes.json");
  const psi = json("psi.json");
  const asked = [];
  return {
    asked,
    origin: "https://fixture.test",
    fetch: async (url, init = {}) => {
      if (url.startsWith(PSI_ENDPOINT)) return psiResponse(psi[new URL(new URL(url).searchParams.get("url")).pathname]);
      asked.push(url);
      const u = new URL(url);
      const away = routes.offsite[u.pathname];
      const moved = routes.redirects[u.pathname];
      if (init.redirect === "manual" && (away || moved)) {
        // As Node's fetch answers redirect: "manual": the 3xx itself.
        return new Response(null, { status: away ? 302 : 301, headers: { location: away ?? moved } });
      }
      if (away) {
        // redirect: "follow": fetch answers with the other host.
        asked.push(away);
        const res = new Response("<form></form>", { status: routes.offsite_status, headers: { "content-type": "text/html" } });
        Object.defineProperty(res, "url", { value: away });
        return res;
      }
      const path = routes.redirects[u.pathname] ?? u.pathname;
      const file = join(fixtures, pages[path] ?? routes.files[path] ?? join("site", path, "index.html"));
      const found = (path.endsWith("/") || routes.files[path]) && existsSync(file);
      const res = found
        ? new Response(readFileSync(file), { headers: { "content-type": file.endsWith(".json") ? "application/json" : "text/html; charset=utf-8" } })
        : new Response("<h1>Not found</h1>", { status: 404, headers: { "content-type": "text/html" } });
      Object.defineProperty(res, "url", { value: new URL(path, u.origin).href });
      return res;
    },
    launch: async () => {
      throw new Error("the fixture site never launches a browser");
    },
    runAudit: async () => audit,
    // Raw observations, as measureLab returns them, for the pages PSI missed.
    runLab: async () => json("lab.json"),
    // The keyboard pass, one result per route, as keyboardPass resolves.
    runKeyboard: async (routes) => ({
      tasks: routes.map(({ hops }) => {
        const hop = hops.findIndex((h) => keyboard[h.link]);
        return hop < 0 ? { status: "done" } : { hop, ...keyboard[hops[hop].link] };
      }),
      read_at: "2026-11-04T00:00:00.000Z",
    }),
  };
}

const tbtDef = () => targets.find((t) => t.id === "usability.tbt_mobile");
// Where a value falls against its target's goal and near band.
const meets = (t, v) => (t.direction === "lower" ? v <= t.goal : v >= t.goal);
const pastNear = (t, v) => (t.direction === "lower" ? v > t.near : v < t.near);

test("targets and collector agree on the metric ids, and every target is well formed", async () => {
  assert.equal(area, "usability");
  const got = await run(fixtureSite());
  assert.deepEqual(Object.keys(got).sort(), targets.map((t) => t.id).sort());
  for (const t of targets) {
    assert.equal(t.tab, "usability", t.id);
    assert.ok(["quality", "speed", "consumption"].includes(t.kind), t.id);
    assert.ok(t.label.split(/\s+/).length <= 6, `${t.id} label over 6 words`);
    assert.ok(["higher", "lower"].includes(t.direction), t.id);
    assert.ok(t.direction === "lower" ? t.near >= t.goal : t.near <= t.goal, `${t.id} near band is on the wrong side`);
    assert.ok(["none", "github-admin", "cloudflare", "local-files", "project-scope"].includes(t.needs), t.id);
    assert.ok(["number", "bar", "gauge", "spark", "table"].includes(t.chart), t.id);
    assert.ok(t.goal_source && t.source && t.unit, t.id);
    assert.match(t.goal_source, /\bgoal\b/i, `${t.id} goal_source must label the goal as a goal`);
    assert.match(t.source, /^(state|latest): /, `${t.id} source names its basis`);
  }
});

test("known-good fixture returns the hand-worked values", async () => {
  const site = fixtureSite();
  const got = await collect({ root, mode: "local", params: FIXTURE, site });

  // Crawl: /missing-page/ (linked from / first) and /broken-from-rankings/.
  assert.equal(got["usability.broken_links"].value, 2);
  // The rows hold a status code, not a count of targets, so they say so.
  assert.deepEqual(got["usability.broken_links"].detail, [
    { label: "/missing-page/ ← /", value: 404, unit: "HTTP status" },
    { label: "/broken-from-rankings/ ← /rankings/", value: 404, unit: "HTTP status" },
  ]);
  assert.match(got["usability.broken_links"].source, /13 fetched, every reachable page/);
  // Never fetched: /api/ (params.crawl_skip), mailto:, other origins, commented-out links.
  assert.equal(site.asked.filter((u) => /\/api\/|mailto:|linkedin|commented-out/.test(u)).length, 0);

  // No page links /chat/, so the chat task reaches the form: / -> /links/ ->
  // the form (2); / -> /newsletter/ -> /rankings/ -> nominate (3); /privacy
  // redirects to /privacy/ (1); "apply/" is relative to /join/ (2).
  assert.equal(got["usability.task_clicks"].value, 3);
  assert.deepEqual(got["usability.task_clicks"].detail, [
    { label: "Join the chat (via the form link)", value: 2 },
    { label: "Find resources", value: 1 },
    { label: "Nominate a company", value: 3 },
    { label: "Apply for a seat", value: 2 },
    { label: "Subscribe", value: 1 },
    { label: "Privacy policy", value: 1 },
  ]);
  // Tab reaches every link on each task's route.
  assert.equal(got["usability.keyboard_task_share"].value, 100);
  assert.equal(got["usability.keyboard_task_share"].detail.length, 6);
  assert.equal(got["usability.keyboard_task_share"].read_at, "2026-11-04T00:00:00.000Z");

  // "/": 8 words, 2 sentences, 16 syllables: 0.39*4 + 11.8*2 - 15.59 = 9.57.
  // "/places/": 31 one-syllable words in one sentence: 0.39*31 + 11.8 - 15.59 = 8.30.
  // "/people/" has no line ending in sentence punctuation, so no grade.
  assert.equal(got["usability.reading_grade"].value, 9.6);
  assert.deepEqual(got["usability.reading_grade"].detail, [
    { label: "/", value: 9.6 },
    { label: "/places/", value: 8.3 },
  ]);
  assert.match(got["usability.reading_grade"].source, /no prose on \/people\//);
  assert.equal(got["usability.long_sentences"].value, 1);
  assert.match(got["usability.long_sentences"].source, /sentences over 30 words \(params\.long_sentence_words\)/);

  assert.equal(got["usability.words_before_action"].value, 140);
  assert.deepEqual(got["usability.words_before_action"].detail.at(-1), { label: "/people/ (no link or button)", value: 140 });

  // region x2 + link-name on "/" (the 375 px header repeats), image-alt on
  // /people/. color-contrast and target-size have metrics of their own.
  assert.equal(got["usability.axe_violations"].value, 4);
  assert.deepEqual(got["usability.axe_violations"].detail, [
    { label: "region (first: header on /)", value: 2 },
    { label: "image-alt (first: img.a on /people/)", value: 1 },
    { label: "link-name (first: a.icon on /)", value: 1 },
  ]);
  // "/" at 375: a.tiny (twice) and button.x; /people/ at 375: a.tiny.
  assert.equal(got["usability.target_size_375"].value, 3);
  assert.deepEqual(got["usability.target_size_375"].detail.map((d) => d.label), ["/ (a.tiny, button.x)", "/people/ (a.tiny)"], "each page names its small targets");
  assert.match(got["usability.target_size_375"].source, /key pages at 375 px/);
  assert.match(got["usability.target_size_375"].source, /\/directory\/, \/rankings\/, \/places\/, \/join\/ \(not read\)/);

  // apply: email; newsletter: email; suggest answered 503 and is named.
  assert.equal(got["usability.unlabeled_fields"].value, 2);
  assert.match(got["usability.unlabeled_fields"].source, /\/directory\/suggest\/ \(HTTP 503\)/);
  // Form page bytes, recorded in KiB: apply 2,000, nominate 500, newsletter 1,800.
  assert.equal(got["usability.form_page_kib"].value, 2000);
  assert.deepEqual(got["usability.form_page_kib"].detail, [
    { label: "/join/apply/", value: 2000 },
    { label: "/rankings/nominate/", value: 500 },
    { label: "/newsletter/", value: 1800 },
  ]);
  assert.match(got["usability.form_page_kib"].source, /\/directory\/suggest\/ \(HTTP 503\)/);
  // Past the 1,600 KiB goal but inside the near band: near, not a miss.
  const kib = targets.find((t) => t.id === "usability.form_page_kib");
  assert.ok(!meets(kib, 2000) && !pastNear(kib, 2000));

  // TBT: PSI answered 5 of 6; /rankings/ was a 500, so the lab measured
  // it (fixtures/usability/lab.json). FCP 1000 ms: the 300 ms task from 800
  // clips to 100 ms (50 blocking), the 700 ms task adds 650, and the task at
  // 20 s starts after the window closed at 16 s. 50 + 650 = 700.
  assert.equal(got["usability.tbt_mobile"].value, 700);
  assert.deepEqual(got["usability.tbt_mobile"].detail, [
    { label: "/ (PSI)", value: 150 },
    { label: "/directory/ (PSI)", value: 450 },
    { label: "/rankings/ (lab; blocking: 700 ms at 2.0 s; 300 ms at 0.8 s)", value: 700 },
    { label: "/places/ (PSI)", value: 90 },
    { label: "/people/ (PSI)", value: 310 },
    { label: "/join/ (PSI)", value: 210 },
  ]);
  assert.match(got["usability.tbt_mobile"].source, /^lab fallback, our numbers and not Google's/);
  assert.match(got["usability.tbt_mobile"].source, /for \/rankings\/, where PageSpeed Insights did not answer: \/rankings\/ \(HTTP 500\)/);
  assert.match(got["usability.tbt_mobile"].source, /6 of 6 key pages measured; value is the worst page, \/rankings\/ \(lab; blocking: 700 ms/);
  // A known-bad lab sample is past the near band: a miss, never a pass.
  assert.ok(pastNear(tbtDef(), got["usability.tbt_mobile"].value));
});

test("lab TBT sums each long task's time past 50 ms between FCP and the window's end", () => {
  // Lighthouse's clipping: a task straddling FCP counts only its part after
  // FCP, and that part must itself pass 50 ms.
  assert.equal(tbtFromTasks([{ startTime: 900, duration: 200 }], 1000, 5000), 50);
  assert.equal(tbtFromTasks([{ startTime: 900, duration: 140 }], 1000, 5000), 0);
  assert.equal(tbtFromTasks([{ startTime: 4900, duration: 300 }], 1000, 5000), 50);
  assert.equal(tbtFromTasks([{ startTime: 400, duration: 500 }], 1000, 5000), 0);
  assert.equal(tbtFromTasks([{ startTime: 6000, duration: 500 }], 1000, 5000), 0);
  assert.equal(tbtFromTasks([{ startTime: 1200, duration: 50 }, { startTime: 2000, duration: 49 }], 1000, 5000), 0);
  assert.equal(tbtFromTasks([{ startTime: 1200, duration: 120 }, { startTime: 2000, duration: 90 }], 1000, 5000), 110);
  assert.equal(tbtFromTasks([{ startTime: 1200, duration: 120 }], 5000, 1000), 0);

  const clean = labVitals({ fcp: 800, lcp: [{ startTime: 1000 }], shifts: [], tasks: [{ startTime: 900, duration: 120 }, { startTime: 3000, duration: 45 }], end: 9000 });
  assert.equal(clean.tbt_ms, 70);
  assert.ok(meets(tbtDef(), clean.tbt_ms));
  const bad = labVitals({ fcp: 800, lcp: [{ startTime: 1000 }], shifts: [], tasks: [{ startTime: 1500, duration: 900 }], end: 9000 });
  assert.equal(bad.tbt_ms, 850);
  assert.ok(pastNear(tbtDef(), bad.tbt_ms));
});

test("one run reads each page once, however many collectors ask", async () => {
  const site = fixtureSite();
  await run(site);
  const first = site.asked.length;
  await run(site);
  await crawl(site, { max: FIXTURE.crawl_max, skip: FIXTURE.crawl_skip });
  assert.equal(site.asked.length, first);
  assert.equal(new Set(site.asked).size, site.asked.length);
});

test("the crawl stops at its limit and says so", async () => {
  const site = fixtureSite();
  const small = await crawl(site, { max: 3 });
  assert.equal(small.pages.size, 3);
  assert.equal(small.truncated, true);
});

test("missing inputs read could_not_check, never 0 and never a throw", async () => {
  const site = {
    origin: "https://fixture.test",
    fetch: async () => {
      throw new TypeError("fetch failed");
    },
    launch: async () => {
      throw new Error("no browser");
    },
  };
  const got = await run(site);
  for (const t of targets) {
    assert.equal(typeof got[t.id].could_not_check, "string", `${t.id} should be could_not_check`);
    assert.equal("value" in got[t.id], false, `${t.id} must not carry a value`);
  }
  assert.match(got["usability.broken_links"].could_not_check, /fetch failed/);
  assert.match(got["usability.reading_grade"].could_not_check, /no browser/);
  // PSI unreachable and no browser for the lab: both reasons, never 0.
  assert.match(got["usability.tbt_mobile"].could_not_check, /PageSpeed Insights: fetch failed; lab: no browser/);
});

test("a repo with no site, no tasks or no form pages: could_not_check naming the param", async () => {
  const none = await collect({ root, mode: "ci" });
  for (const t of targets) assert.match(none[t.id].could_not_check, /names no site: set params\.origin/, t.id);
  const bare = await run(fixtureSite(), { ...FIXTURE, tasks: [], form_pages: [] });
  assert.match(bare["usability.task_clicks"].could_not_check, /params\.tasks names no task/);
  assert.match(bare["usability.keyboard_task_share"].could_not_check, /params\.tasks names no task/);
  assert.match(bare["usability.unlabeled_fields"].could_not_check, /params\.form_pages names no form page/);
  assert.match(bare["usability.form_page_kib"].could_not_check, /params\.form_pages names no form page/);
  assert.equal(bare["usability.broken_links"].value, 2, "the crawl still reads");
  const wide = await run(fixtureSite(), { ...FIXTURE, widths: [1280] });
  assert.match(wide["usability.target_size_375"].could_not_check, /params\.widths has no phone width/);
});

test("a task whose goals are all unreached is could_not_check, not a click count", async () => {
  const got = await run(fixtureSite(), { ...FIXTURE, tasks: [{ label: "Join the chat", goals: [{ path: "/chat/" }, { path: "/chat" }] }] });
  assert.match(got["usability.task_clicks"].could_not_check, /Join the chat: no link to \/chat\/ or \/chat reached from \/ \(13 fetched/);
  assert.equal("value" in got["usability.task_clicks"], false);
  assert.match(got["usability.keyboard_task_share"].could_not_check, /no task's route was reached from \//);
  assert.equal(got["usability.broken_links"].value, 2);
});

test("a task route follows the clicks the crawl counts, to the page linking the goal", async () => {
  const links = await crawl(fixtureSite(), { skip: FIXTURE.crawl_skip });
  const hops = (goal, from = links) => taskRoute(from, goal)?.map((h) => `${h.from} -> ${h.link.replace("https://fixture.test", "")} => ${h.to}`);
  assert.deepEqual(hops({ path: "/rankings/nominate/" }), [
    "/ -> /newsletter/?ref=home => /newsletter/",
    "/newsletter/ -> /rankings/ => /rankings/",
    "/rankings/ -> /rankings/nominate/ => /rankings/nominate/",
  ]);
  // An off-site goal ends on the nearest page linking it; /privacy lands on /privacy/.
  assert.deepEqual(hops({ href: "https://forms.example/chat-invite" }), ["/ -> /links/ => /links/", "/links/ -> https://forms.example/chat-invite?usp=sf => null"]);
  assert.deepEqual(hops({ path: "/privacy/" }), ["/ -> /privacy => /privacy/"]);
  assert.equal(taskRoute(links, { path: "/chat/" }), null);
  // A short link that redirects off the site leaves it: Enter is never pressed on it.
  const chat = await crawl(fixtureSite({ pages: { "/": "site-chat-link/index.html" } }), { skip: FIXTURE.crawl_skip });
  assert.deepEqual(hops({ path: "/chat/" }, chat), ["/ -> /chat/ => null"]);
});

test("keyboard share: missed and wrong tasks score 0; capped and unloaded tasks are named, never 0", async () => {
  const keyboard = {
    "https://fixture.test/directory/": { status: "error", error: "page.goto: Timeout 60000ms exceeded." },
    "https://fixture.test/rankings/nominate/": { status: "missed" },
    "https://fixture.test/join/apply/": { status: "wrong", landed: "/join/" },
    "https://fixture.test/privacy": { status: "capped" },
  };
  const got = (await run(fixtureSite({ keyboard })))["usability.keyboard_task_share"];
  // Counted: chat and subscribe done, nominate and apply failed.
  assert.equal(got.value, 50);
  assert.deepEqual(got.detail, [
    { label: "Join the chat", value: 1, unit: "" },
    { label: "Nominate a company (Tab never reaches /rankings/nominate/ on /rankings/)", value: 0, unit: "" },
    { label: "Apply for a seat (Enter on /join/apply/ lands on /join/, not /join/apply/)", value: 0, unit: "" },
    { label: "Subscribe", value: 1, unit: "" },
  ]);
  assert.match(got.source, /not counted: Find resources \(page\.goto: Timeout 60000ms exceeded\.\); Privacy policy \(2000 Tab presses on \/ without reaching \/privacy\)$/);
  // Every task's first link capped: nothing read, so could_not_check.
  const firsts = ["/links/", "/directory/", "/newsletter/?ref=home", "/join/", "/privacy"];
  const unread = await run(fixtureSite({ keyboard: Object.fromEntries(firsts.map((p) => [`https://fixture.test${p}`, { status: "capped" }])) }));
  assert.match(unread["usability.keyboard_task_share"].could_not_check, /^no task could be read; not counted: /);
  const site = fixtureSite();
  delete site.runKeyboard;
  const blind = await run(site);
  assert.match(blind["usability.keyboard_task_share"].could_not_check, /never launches a browser/);
  assert.equal("value" in blind["usability.keyboard_task_share"], false);
});

test("a chat link on /: one click via /chat/, and its off-site 302 is no broken link", async () => {
  const site = fixtureSite({ pages: { "/": "site-chat-link/index.html", "/links/": "site-chat-link/links/index.html" } });
  const got = await run(site);
  // / -> /chat/ (1). No page links the form, so only the /chat/ goal reaches it.
  assert.deepEqual(got["usability.task_clicks"].detail[0], { label: "Join the chat (via /chat/)", value: 1 });
  assert.equal(got["usability.task_clicks"].value, 3);
  assert.match(got["usability.task_clicks"].source, /a task with several goals takes the fewest clicks/);
  // /chat/ ends on the form host, which answers 403 here; it is not counted.
  assert.equal(got["usability.broken_links"].value, 2);
  assert.equal(got["usability.broken_links"].detail.some((d) => d.label.startsWith("/chat/")), false);
});

test("the crawl records an off-site redirect and never fetches the other host", async () => {
  const site = fixtureSite({ pages: { "/": "site-chat-link/index.html", "/links/": "site-chat-link/links/index.html" } });
  const links = await crawl(site, { skip: FIXTURE.crawl_skip });
  assert.deepEqual(links.pages.get("/chat/"), { status: 302, final: "https://forms.example/chat-invite", links: [] });
  assert.deepEqual(site.asked.filter((u) => new URL(u).origin !== site.origin), []);
  // The form host's 403 would have listed /chat/ as broken.
  assert.equal(brokenLinks(links).has("/chat/"), false);
  // A same-site redirect is still followed: /privacy lands on /privacy/.
  const before = await crawl(fixtureSite(), { skip: FIXTURE.crawl_skip });
  assert.equal(before.pages.get("/privacy")?.final, "/privacy/");
  assert.equal(before.pages.get("/privacy")?.status, 200);
});

test("two goals reached: the fewer clicks wins", async () => {
  // / links /chat/ (1) and /links/ still links the form (2).
  const got = await run(fixtureSite({ pages: { "/": "site-chat-link/index.html" } }));
  assert.deepEqual(got["usability.task_clicks"].detail[0], { label: "Join the chat (via /chat/)", value: 1 });
});

test("known-bad: neither /chat/ nor the form is linked, so could_not_check", async () => {
  const got = await run(fixtureSite({ pages: { "/links/": "site-no-chat/links/index.html" } }));
  assert.match(
    got["usability.task_clicks"].could_not_check,
    /Join the chat: no link to \/chat\/ or \/chat or the form link reached from \//,
  );
  assert.equal("value" in got["usability.task_clicks"], false);
});

test("a built static site: the crawl reads the folder, and Google is never asked", async () => {
  const site = siteFor({ site_dir: "site" }, fixtures);
  const asked = [];
  const watched = { ...site, fetch: async (url) => (asked.push(url), site.fetch(url)), launch: async () => { throw new Error("no browser"); } };
  const got = await run(watched);
  assert.equal(asked.filter((u) => u.startsWith(PSI_ENDPOINT)).length, 0);
  assert.equal(got["usability.broken_links"].value, 2);
  assert.deepEqual(got["usability.broken_links"].detail.map((d) => d.label), ["/missing-page/ ← /", "/broken-from-rankings/ ← /rankings/"]);
  assert.equal(got["usability.task_clicks"].value, 3);
  assert.match(got["usability.tbt_mobile"].could_not_check, /not a public URL \(a built static site\); lab: no browser/);
});

test("targets/usability.json: params are generic, and goals cite their public source", () => {
  for (const kind of ["quality", "speed", "consumption"]) assert.ok(targets.some((t) => t.kind === kind), kind);
  assert.equal(targets.filter((t) => t.params).length, 1, "one params block");
  assert.equal(PARAMS.origin, "");
  assert.deepEqual(PARAMS.tasks, []);
  assert.deepEqual(PARAMS.form_pages, []);
  const by = Object.fromEntries(targets.map((t) => [t.id, t]));
  assert.ok(by["usability.long_sentences"].label.includes(`${PARAMS.long_sentence_words} words`));
  assert.match(by["usability.keyboard_task_share"].goal_source, /WCAG 2\.2 Success Criterion 2\.1\.1 Keyboard \(Level A\)/);
  for (const id of ["usability.axe_violations", "usability.target_size_375", "usability.unlabeled_fields"]) {
    assert.match(by[id].goal_source, /WCAG 2\.2 AA/, id);
  }
  assert.match(by["usability.tbt_mobile"].goal_source, /web\.dev, Total Blocking Time, updated 2024-11-04.*web\.dev, Interaction to Next Paint, updated 2025-09-02/);
});

test("reading helpers", () => {
  assert.equal(syllables("America"), 4);
  assert.equal(syllables("companies"), 3);
  assert.equal(syllables("stone"), 1);
  assert.equal(syllables("2026"), 1);
  const s = readingStats("Heading\nFounders build companies in America. Investors fund them.\nButton");
  assert.deepEqual([s.sentences, s.words, s.grade], [2, 8, 9.6]);
  assert.deepEqual(readingStats("Just a heading\nAnother label"), { sentences: 0, words: 0, grade: null, long: [] });
  assert.equal(readingStats(`${"word ".repeat(31).trim()}.`).long.length, 1);
  assert.equal(readingStats(`${"word ".repeat(30).trim()}.`).long.length, 0);
  assert.equal(readingStats(`${"word ".repeat(21).trim()}.`, 20).long.length, 1, "the limit is a param");
});

test("extractLinks resolves, decodes and drops what a visitor cannot follow", () => {
  const html = `<a href="/a?x=1&amp;y=2#top">A</a><a class="b" href='b/'>B</a><a href=#skip>S</a>
    <a href="mailto:x@example.org">M</a><a href="tel:+1">T</a><!-- <a href="/gone/">G</a> --><a href="https://other.test/">O</a>`;
  assert.deepEqual(extractLinks(html, "https://fixture.test/dir/"), [
    "https://fixture.test/a?x=1&y=2",
    "https://fixture.test/dir/b/",
    "https://other.test/",
  ]);
});

test("formFields and axe target-size work in a real browser", async (t) => {
  let why = "";
  const browser = await launchChrome().catch((e) => ((why = String(e?.message ?? e).split("\n")[0]), null));
  // A job without a browser skips and says why; the jobs that install Chrome run it.
  if (!browser) return t.skip(`no usable Chrome or Chromium here: ${why}`);
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
    await page.setContent(`<main><form>
      <label>Name <input name="name"></label>
      <label for="e">Email</label><input id="e" name="email">
      <input name="phone" placeholder="Phone">
      <input name="q" aria-label="Search">
      <span id="lb">Company</span><input name="company" aria-labelledby="lb">
      <textarea name="msg" title="Message"></textarea>
      <select name="stage"><option>Seed</option></select>
      <input type="hidden" name="ts"><input type="submit" value="Send">
      <div aria-hidden="true"><input name="hp" tabindex="-1"></div>
      <input name="gone" style="display:none">
    </form>
    <div><a href="/x" style="display:inline-block;width:10px;height:10px;overflow:hidden">x</a><a href="/y" style="display:inline-block;width:10px;height:10px;overflow:hidden">y</a></div></main>`);
    const fields = await page.evaluate(formFields);
    assert.deepEqual(
      fields.filter((f) => !f.labeled).map((f) => f.field),
      ["phone", "stage"],
    );
    assert.equal(fields.length, 7);
    await page.addScriptTag({ path: createRequire(import.meta.url).resolve("axe-core/axe.min.js") });
    const violations = await page.evaluate(runAxe);
    assert.equal(violations.find((v) => v.id === "target-size")?.targets.length, 2);
  } finally {
    await browser.close();
  }
});

// Runs where Chrome is: pages.yml's action-collect job sets
// QUALITY_REQUIRE_CHROME, so a browser that fails to start fails there.
test("keyboardPass follows routes by Tab and Enter in Chrome", async (t) => {
  const origin = "https://keyboard.test";
  const pages = {
    "/": `<button>Menu</button><a href="/next/#top">Next</a><a href="/trap/" tabindex="-1">Trap</a><a href="/js/" id="js">Docs</a>
      <script>document.getElementById("js").addEventListener("click", (e) => { e.preventDefault(); location.href = "/elsewhere/"; });</script>`,
    "/next/": `<a href="https://off.example/form">Form</a>`,
    "/elsewhere/": `<p>Elsewhere</p>`,
    "/many/": `${"<button>b</button>".repeat(12)}<a href="/next/">Next</a>`,
  };
  const site = {
    origin,
    maxTabs: 8,
    launch: () => launchChrome(),
    setup: (context) =>
      context.route(`${origin}/**`, (route) => {
        const body = pages[new URL(route.request().url()).pathname];
        return route.fulfill(body ? { contentType: "text/html", body: `<!doctype html><title>t</title>${body}` } : { status: 404, body: "" });
      }),
  };
  const hop = (from, path) => ({ from, link: new URL(path, origin).href, to: path });
  const run = await keyboardPass(site, [
    { label: "done", hops: [hop("/", "/next/"), { from: "/next/", link: "https://off.example/form", to: null }] },
    { label: "missed", hops: [hop("/", "/trap/")] },
    { label: "wrong", hops: [hop("/", "/js/")] },
    { label: "capped", hops: [hop("/many/", "/next/")] },
  ]);
  if (run.error && !process.env.QUALITY_REQUIRE_CHROME) return t.skip(`no Chrome here (${run.error})`);
  assert.equal(run.error, undefined);
  // The hash on /next/#top is dropped; tabindex="-1" is never reached; the
  // script sends Docs elsewhere; 12 buttons outlast 8 presses.
  assert.deepEqual(run.tasks, [
    { status: "done" },
    { status: "missed", hop: 0 },
    { status: "wrong", hop: 0, landed: "/elsewhere/" },
    { status: "capped", hop: 0 },
  ]);
});
