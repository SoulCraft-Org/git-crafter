// node --test quality/collectors/site/design.test.mjs
// Known-good fixture values are counted by hand from quality/fixtures/design/;
// the comments beside each expectation say where they come from.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PARAMS } from "./design.mjs";
import { area, collect } from "./design.mjs";
import {
  LAB,
  PSI_ENDPOINT,
  PSI_METHOD,
  clsFromShifts,
  colorKey,
  hexToKey,
  labShifts,
  labVitals,
  launchChrome,
  lcpFromEntries,
  measureLab,
  mergeVitals,
  pageFacts,
  parsePsi,
  serveStatic,
  siteFor,
  STATIC_ORIGIN,
  vitalsMetric,
} from "./site-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "..", "fixtures", "design");
const targets = JSON.parse(readFileSync(join(here, "..", "..", "targets", "design.json"), "utf8"));
const json = (file) => JSON.parse(readFileSync(join(fixtures, file), "utf8"));
// The fixture site's override over the template's params: six key pages, its
// source folder, a generated token file and one approved line left out.
const FIXTURE = {
  ...PARAMS,
  key_pages: ["/", "/directory/", "/rankings/", "/places/", "/people/", "/join/"],
  src_dirs: ["site/src"],
  raw_scan_exempt: [
    { file: "site/src/styles/tokens.css", why: "generated from tokens/brand.yaml" },
    { file: "site/src/layouts/BaseLayout.astro", line: 'name="theme-color"', why: "the browser theme color, chosen on purpose" },
  ],
  tokens: { file: "tokens/brand.yaml", colors: "color", type: "type", type_prefix: "step" },
};
// Where a value falls against its target's goal and near band.
const meets = (t, v) => (t.direction === "lower" ? v <= t.goal : v >= t.goal);
const pastNear = (t, v) => (t.direction === "lower" ? v > t.near : v < t.near);

// A PSI v5 response cut to the fields parsePsi reads.
function psiResponse(entry) {
  if (!entry) return new Response("{}", { status: 404 });
  if (entry.status) return new Response('{"error":{"code":429}}', { status: entry.status });
  const audits = {
    "largest-contentful-paint": { numericValue: entry.lcp_ms },
    "cumulative-layout-shift": { numericValue: entry.cls },
    "total-blocking-time": { numericValue: entry.tbt_ms },
  };
  return Response.json({
    lighthouseResult: {
      lighthouseVersion: "12.0.0",
      ...(entry.runtimeError ? { runtimeError: { code: entry.runtimeError }, audits: {} } : { audits }),
    },
  });
}

function fixtureSite({ psi = json("psi.json") } = {}) {
  const audit = json("audit.json");
  const psiAsked = [];
  const labAsked = [];
  return {
    psiAsked,
    labAsked,
    origin: "https://fixture.test",
    fetch: async (url) => {
      if (!url.startsWith(PSI_ENDPOINT)) return new Response("", { status: 404 });
      const path = new URL(new URL(url).searchParams.get("url")).pathname;
      psiAsked.push(path);
      return psiResponse(psi[path]);
    },
    launch: async () => {
      throw new Error("the fixture site never launches a browser");
    },
    runAudit: async () => audit,
    // Raw observations, as measureLab returns them, for the pages PSI missed.
    runLab: async (paths) => (labAsked.push(...paths), json("lab.json")),
  };
}

const shift = (startTime, value, hadRecentInput = false) => ({ startTime, value, hadRecentInput });
const def = (id) => targets.find((t) => t.id === id);

test("targets and collector agree on the metric ids, and every target is well formed", async () => {
  assert.equal(area, "design");
  const got = await collect({ root: join(fixtures, "root"), mode: "ci", params: FIXTURE, site: fixtureSite() });
  assert.deepEqual(Object.keys(got).sort(), targets.map((t) => t.id).sort());
  for (const t of targets) {
    assert.equal(t.tab, "design", t.id);
    assert.ok(["quality", "speed", "consumption"].includes(t.kind), t.id);
    assert.ok(t.label.split(/\s+/).length <= 6, `${t.id} label over 6 words`);
    assert.ok(["higher", "lower"].includes(t.direction), t.id);
    assert.ok(t.direction === "lower" ? t.near >= t.goal : t.near <= t.goal, `${t.id} near band is on the wrong side`);
    assert.ok(["none", "github-admin", "cloudflare", "local-files", "project-scope"].includes(t.needs), t.id);
    assert.ok(["number", "bar", "gauge", "spark", "table"].includes(t.chart), t.id);
    assert.ok(t.goal_source && t.source && t.unit, t.id);
  }
});

test("known-good fixture returns the hand-counted values", async () => {
  const site = fixtureSite();
  const got = await collect({ root: join(fixtures, "root"), mode: "local", params: FIXTURE, site });

  // hall.css: 4px 8px 1px 2px 1.5px 768px; BaseLayout: 12px; Card: 10px.
  // Comments, tokens.css and lib/sizes.ts do not count.
  assert.equal(got["design.raw_px"].value, 8);
  assert.deepEqual(got["design.raw_px"].detail, [
    { label: "site/src/styles/hall.css", value: 6 },
    { label: "site/src/components/Card.astro", value: 1 },
    { label: "site/src/layouts/BaseLayout.astro", value: 1 },
  ]);
  // #fff, fill="#A3400F", #2b1d12aa. Not theme-color (an exempt line), not href="#add".
  assert.equal(got["design.raw_hex"].value, 3);
  assert.match(got["design.raw_hex"].source, /BaseLayout\.astro \(one line\): the browser theme color/);

  // Scale is 15, 18, 24 px. Off: 17px (2 + 1 elements), 13px (1). The headline
  // counts sizes and the rows count elements, so each row names its unit.
  assert.equal(got["design.font_sizes_off_scale"].value, 2);
  assert.deepEqual(got["design.font_sizes_off_scale"].detail, [
    { label: "17px", value: 3, unit: "elements" },
    { label: "13px", value: 1, unit: "elements" },
  ]);
  // rgba(163,64,15,0.5) is the link token at half alpha; rgba(0,0,0,0) is
  // invisible. Off: color(srgb 0.5 ...) = 128,128,128 (2), rgb(0, 0, 0) (1).
  assert.equal(got["design.text_colors_off_token"].value, 2);
  assert.deepEqual(got["design.text_colors_off_token"].detail, [
    { label: "color(srgb 0.5 0.5 0.5)", value: 2, unit: "elements" },
    { label: "rgb(0, 0, 0)", value: 1, unit: "elements" },
  ]);

  // "/": .hero p, .badge (1280) and .nav a (375); .hero p once. "/people/": 0.
  assert.equal(got["design.contrast_violations"].value, 3);
  assert.deepEqual(got["design.contrast_violations"].detail, [
    { label: "/", value: 3 },
    { label: "/people/", value: 0 },
  ]);

  // KiB: /people/@1280 is heaviest; /people/@375 answered 503 and is named.
  assert.equal(got["design.total_bytes"].value, 1536);
  assert.match(got["design.total_bytes"].source, /\/people\/@375 \(HTTP 503\)/);
  assert.equal(got["design.total_bytes"].read_at, "2026-11-02T20:00:00.000Z");

  // PSI: /rankings/ is a Lighthouse error and /people/ a 429. After the 429
  // no call is made, so /join/'s slow fixture values never count.
  assert.deepEqual(site.psiAsked, ["/", "/directory/", "/rankings/", "/places/", "/people/"]);
  // The lab measures exactly the three pages PSI did not answer, from
  // fixtures/design/lab.json; /join/ answered 503 there too.
  assert.deepEqual(site.labAsked, ["/rankings/", "/people/", "/join/"]);
  // LCP: PSI 2.1, 3.4, 2.6 s; lab /rankings/ 2300 ms, /people/ 5200 ms.
  assert.equal(got["design.lcp_mobile"].value, 5.2);
  assert.deepEqual(got["design.lcp_mobile"].detail, [
    { label: "/ (PSI)", value: 2.1 },
    { label: "/directory/ (PSI)", value: 3.4 },
    { label: "/rankings/ (lab)", value: 2.3 },
    { label: "/places/ (PSI)", value: 2.6 },
    { label: "/people/ (lab)", value: 5.2 },
  ]);
  // CLS: /rankings/ has eight 0.01 shifts 900 ms apart, and the 5 s limit
  // closes the first window after six (0.06). /people/: the flagged 0.02 at
  // 200 ms comes before any unflagged shift, so it counts (emulation, not
  // input); 0.02 + 0.1 + 0.1 + 0.1 = 0.32; the flagged 0.5 after them does not.
  assert.equal(got["design.cls_mobile"].value, 0.32);
  assert.deepEqual(
    got["design.cls_mobile"].detail.map((d) => d.value),
    [0.02, 0.12, 0.06, 0.004, 0.32],
  );
  // The source leads with the lab, names why PSI missed each page, and says
  // which page set the value.
  const source = got["design.lcp_mobile"].source;
  assert.match(source, /^lab fallback, our numbers and not Google's: Playwright on Chromium fixture/);
  assert.match(source, /4x CPU slowdown, 562\.5 ms request latency, 1474\.56 Kbps down, 675 Kbps up; 412 x 823 px at 1\.75x/);
  assert.match(
    source,
    /for \/rankings\/, \/people\/, where PageSpeed Insights did not answer: \/rankings\/ \(Lighthouse runtimeError NO_FCP\); \/people\/ \(HTTP 429/,
  );
  assert.match(source, /PageSpeed Insights API v5, mobile \(Google's Lighthouse lab, no key\), for \/, \/directory\/, \/places\//);
  assert.match(source, /5 of 6 key pages measured; value is the worst page, \/people\/ \(lab\)/);
  assert.match(source, /not measured: \/join\/ \(PageSpeed Insights: HTTP 429, .*PageSpeed Insights API key; lab: HTTP 503\)/);
  // Both lab values miss their goals: a known-bad sample scores 0, never a pass.
  assert.ok(pastNear(def("design.lcp_mobile"), got["design.lcp_mobile"].value));
  assert.ok(pastNear(def("design.cls_mobile"), got["design.cls_mobile"].value));
});

test("a spent PageSpeed quota names the key and makes one call, not six", async () => {
  const site = {
    origin: "https://fixture.test",
    fetch: async () => new Response('{"error":{"code":429}}', { status: 429 }),
    runAudit: async () => json("audit.json"),
    launch: async () => {
      throw new Error("no browser");
    },
  };
  let calls = 0;
  const counted = { ...site, fetch: async (...a) => (calls++, site.fetch(...a)) };
  const got = await collect({ root: join(fixtures, "root"), mode: "ci", params: FIXTURE, site: counted });
  assert.equal(calls, 1);
  assert.match(got["design.lcp_mobile"].could_not_check, /need a PageSpeed Insights API key/);
  assert.match(got["design.cls_mobile"].could_not_check, /keyless PageSpeed Insights quota is spent/);
  // No browser for the lab either: could_not_check with both reasons, never 0.
  assert.match(got["design.lcp_mobile"].could_not_check, /lab: no browser/);
  assert.equal("value" in got["design.lcp_mobile"], false);
});

test("PSI stays first: when it answers every page the lab never runs", async () => {
  const paths = ["/", "/directory/", "/rankings/", "/places/", "/people/", "/join/"];
  const site = fixtureSite({ psi: Object.fromEntries(paths.map((p) => [p, { lcp_ms: 2000, cls: 0.01, tbt_ms: 100 }])) });
  const got = await collect({ root: join(fixtures, "root"), mode: "ci", params: FIXTURE, site });
  assert.deepEqual(site.labAsked, []);
  assert.equal(got["design.lcp_mobile"].value, 2);
  assert.ok(got["design.lcp_mobile"].detail.every((d) => d.label.endsWith(" (PSI)")));
  assert.ok(got["design.lcp_mobile"].source.startsWith(PSI_METHOD));
  assert.doesNotMatch(got["design.lcp_mobile"].source, /lab fallback/);
});

test("fallback choice: a PSI number is never replaced, and a lab miss is could_not_check for that page", () => {
  const paths = ["/a/", "/b/", "/c/"];
  const psi = { "/a/": { lcp_ms: 1000, cls: 0, tbt_ms: 0, read_at: "t1" }, "/b/": { error: "HTTP 429" }, "/c/": { error: "HTTP 500" } };
  const lab = {
    browser: "1.0",
    read_at: "t2",
    pages: { "/a/": { lcp_ms: 9999, cls: 1, tbt_ms: 9999 }, "/b/": { lcp_ms: 3000, cls: 0.2, tbt_ms: 400 }, "/c/": { error: "HTTP 503" } },
  };
  const run = mergeVitals(paths, psi, lab);
  assert.deepEqual(run.pages["/a/"], { lcp_ms: 1000, cls: 0, tbt_ms: 0, read_at: "t1", via: "psi" });
  assert.deepEqual(run.pages["/b/"], { lcp_ms: 3000, cls: 0.2, tbt_ms: 400, via: "lab", psi_error: "HTTP 429", read_at: "t2" });
  assert.deepEqual(run.pages["/c/"], { error: "PageSpeed Insights: HTTP 500; lab: HTTP 503" });
  const lcp = vitalsMetric(run, 3, (r) => r.lcp_ms);
  assert.equal(lcp.value, 3000);
  assert.deepEqual(lcp.detail, [
    { label: "/a/ (PSI)", value: 1000 },
    { label: "/b/ (lab)", value: 3000 },
  ]);
  assert.equal(lcp.read_at, "t2");
  // No browser at all: every page names both reasons and nothing is measured.
  const none = vitalsMetric(mergeVitals(paths, { "/a/": { error: "HTTP 429" } }, { error: "no browser" }), 3, (r) => r.lcp_ms);
  assert.equal("value" in none, false);
  assert.match(none.could_not_check, /\/a\/ \(PageSpeed Insights: HTTP 429; lab: no browser\)/);
  assert.match(none.could_not_check, /\/b\/, \/c\/ \(PageSpeed Insights: not read; lab: no browser\)/);
});

test("lab LCP and CLS follow web-vitals, with a known-bad and a known-clean sample", () => {
  assert.equal(lcpFromEntries([{ startTime: 800 }, { startTime: 2400 }]), 2400);
  assert.equal(lcpFromEntries([]), null);
  // Session windows: a gap of exactly 1 s opens a new window (the rule is
  // "less than 1 s"), and so does a shift 5 s after the window's first.
  assert.equal(clsFromShifts([]), 0);
  assert.equal(clsFromShifts([shift(0, 0.05), shift(1000, 0.05)]), 0.05);
  assert.equal(clsFromShifts([shift(0, 0.05), shift(999, 0.05)]), 0.1);
  const steady = [0, 900, 1800, 2700, 3600, 4500, 5000].map((t) => shift(t, 0.1));
  assert.equal(Math.round(clsFromShifts(steady) * 1000) / 1000, 0.6);
  // Flagged shifts count only before the first unflagged one (emulation), and
  // without labShifts a flagged shift never counts.
  assert.equal(clsFromShifts(labShifts([shift(100, 0.3, true), shift(300, 0.01), shift(500, 0.4, true)])), 0.31);
  assert.equal(clsFromShifts([shift(100, 0.3, true)]), 0);

  const clean = labVitals({ fcp: 600, lcp: [{ startTime: 900 }], shifts: [shift(700, 0.01)], tasks: [{ startTime: 650, duration: 40 }], end: 8000 });
  assert.deepEqual(clean, { lcp_ms: 900, cls: 0.01, tbt_ms: 0 });
  const bad = labVitals({ fcp: 600, lcp: [{ startTime: 900 }, { startTime: 4800 }], shifts: [shift(3000, 0.3)], tasks: [], end: 8000 });
  assert.deepEqual(bad, { lcp_ms: 4800, cls: 0.3, tbt_ms: 0 });
  // A blocking task names what its long animation frame ran: the longest script, then style and layout.
  const frames = [{ startTime: 1000, duration: 260, layout_ms: 90, scripts: [{ ms: 40, who: "a" }, { ms: 150, who: "DOMWindow.onload client.js" }] }];
  const slow = labVitals({ fcp: 600, lcp: [{ startTime: 900 }], shifts: [], tasks: [{ startTime: 1000, duration: 250 }, { startTime: 650, duration: 40 }], frames, end: 8000 });
  assert.deepEqual(slow, { lcp_ms: 900, cls: 0, tbt_ms: 200, blocking: ["250 ms at 1.0 s (script 150 ms DOMWindow.onload client.js, style and layout 90 ms)"] });
  assert.ok(meets(def("design.lcp_mobile"), clean.lcp_ms / 1000));
  assert.ok(meets(def("design.cls_mobile"), clean.cls));
  assert.ok(pastNear(def("design.lcp_mobile"), bad.lcp_ms / 1000));
  assert.ok(pastNear(def("design.cls_mobile"), bad.cls));

  // A page that never painted was not measured; it is not 0.
  assert.deepEqual(labVitals({ fcp: null, lcp: [], shifts: [], tasks: [], end: 5000 }), { error: "the lab saw no first-contentful-paint" });
  assert.deepEqual(labVitals({ fcp: 500, lcp: [], shifts: [], tasks: [], end: 5000 }), { error: "the lab saw no largest-contentful-paint" });
  assert.deepEqual(labVitals({ error: "HTTP 404" }), { error: "HTTP 404" });
});

test("missing inputs read could_not_check, never 0 and never a throw", async () => {
  const empty = mkdtempSync(join(tmpdir(), "design-empty-"));
  const site = {
    origin: "https://fixture.test",
    fetch: async () => {
      throw new TypeError("fetch failed");
    },
    launch: async () => {
      throw new Error("no browser");
    },
  };
  const got = await collect({ root: empty, mode: "ci", params: FIXTURE, site });
  for (const t of targets) {
    assert.equal(typeof got[t.id].could_not_check, "string", `${t.id} should be could_not_check`);
    assert.ok(got[t.id].could_not_check.length > 0, t.id);
    assert.equal("value" in got[t.id], false, `${t.id} must not carry a value`);
  }
  assert.match(got["design.lcp_mobile"].could_not_check, /fetch failed; lab: no browser/);
  assert.match(got["design.contrast_violations"].could_not_check, /no browser/);
  assert.match(got["design.raw_px"].could_not_check, /no site\/src/);
});

test("a token file that is missing only blocks the two token metrics", async () => {
  const site = fixtureSite();
  const got = await collect({ root: mkdtempSync(join(tmpdir(), "design-notokens-")), mode: "ci", params: FIXTURE, site });
  assert.match(got["design.font_sizes_off_scale"].could_not_check, /tokens\/brand\.yaml/);
  assert.match(got["design.text_colors_off_token"].could_not_check, /tokens\/brand\.yaml/);
  assert.equal(got["design.contrast_violations"].value, 3);
});

test("color and PSI parsing", () => {
  assert.equal(hexToKey("#FFFBF3"), "255,251,243");
  assert.equal(hexToKey("#fff"), "255,255,255");
  assert.equal(hexToKey("not a color"), null);
  assert.deepEqual(colorKey("rgb(43, 29, 18)"), { key: "43,29,18", alpha: 1 });
  assert.deepEqual(colorKey("rgba(43, 29, 18, 0.5)"), { key: "43,29,18", alpha: 0.5 });
  assert.deepEqual(colorKey("rgb(43 29 18 / 50%)"), { key: "43,29,18", alpha: 0.5 });
  assert.deepEqual(colorKey("color(srgb 1 0 0.5)"), { key: "255,0,128", alpha: 1 });
  assert.deepEqual(colorKey("oklch(0.5 0.1 30)"), { key: "oklch(0.5 0.1 30)", alpha: 1 });
  assert.throws(() => parsePsi({}), /no lighthouseResult/);
  assert.throws(() => parsePsi({ lighthouseResult: { audits: {} } }), /largest-contentful-paint/);
});

test("pageFacts reads sizes, colors and words before the first action in a real browser", async (t) => {
  const browser = await launchChrome().catch(() => null);
  if (!browser) return t.skip("no Chrome or Chromium here");
  try {
    const page = await browser.newPage();
    await page.setContent(`<html style="font-size:16px"><body><main>
      <h1 style="font-size:24px;color:#2B1D12">Title</h1>
      <p hidden>Hidden words do not count</p>
      <p style="font-size:17px">Two words <a href="/x">link</a> after</p>
      <script>const notText = 1;</script>
    </main></body></html>`);
    const facts = await page.evaluate(pageFacts);
    assert.deepEqual(facts.fontSizes, { "24px": 1, "17px": 2 });
    assert.equal(facts.colors["rgb(43, 29, 18)"], 1);
    assert.equal(facts.rootPx, 16);
    assert.equal(facts.wordsBeforeAction, 3);
    assert.equal(facts.firstAction, 'a "link"');
  } finally {
    await browser.close();
  }
});

test("measureLab reads LCP, CLS and TBT under Lighthouse's mobile settings in a real browser", async (t) => {
  const browser = await launchChrome().catch(() => null);
  if (!browser) return t.skip("no Chrome or Chromium here");
  // Served through context.route: no port, no network. The bad page grows a
  // box above its text, then blocks the main thread for 300 ms of wall time
  // (a clock-bound loop, so the 4x CPU slowdown does not stretch it).
  const body = {
    bad: `<main><h1>Title</h1><div id="box" style="height:10px"></div><p>${"Words that move. ".repeat(40)}</p>
      <script>setTimeout(() => { document.getElementById("box").style.height = "300px"; const t = performance.now(); while (performance.now() - t < 300) {} }, 800);</script></main>`,
    clean: "<main><h1>Title</h1><p>Plain text, nothing moves.</p></main>",
  };
  const settings = {
    ...LAB,
    quietMs: 1000,
    capMs: 10_000,
    setup: (context) =>
      context.route("https://fixture.test/**", (route) => {
        const name = new URL(route.request().url()).pathname.replaceAll("/", "");
        const head = '<meta name="viewport" content="width=device-width, initial-scale=1">';
        return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head>${head}</head><body>${body[name]}</body></html>` });
      }),
  };
  try {
    const bad = labVitals(await measureLab(browser, "https://fixture.test/bad/", settings));
    const clean = labVitals(await measureLab(browser, "https://fixture.test/clean/", settings));
    assert.equal(bad.error, undefined, bad.error);
    assert.ok(bad.lcp_ms > 0, `bad LCP ${bad.lcp_ms}`);
    assert.ok(bad.cls > 0.1, `bad CLS ${bad.cls}`);
    assert.ok(bad.tbt_ms >= 240, `bad TBT ${bad.tbt_ms}`);
    assert.equal(clean.error, undefined, clean.error);
    assert.ok(clean.lcp_ms > 0, `clean LCP ${clean.lcp_ms}`);
    assert.equal(clean.cls, 0);
    assert.equal(clean.tbt_ms, 0);
  } finally {
    await browser.close();
  }
});

test("a repo with no site: every page metric is could_not_check naming the params, the source scan still reads", async () => {
  const got = await collect({ root: join(fixtures, "root"), mode: "ci", params: { ...FIXTURE, origin: "", site_dir: "" } });
  for (const id of ["design.font_sizes_off_scale", "design.text_colors_off_token", "design.contrast_violations", "design.total_bytes", "design.lcp_mobile", "design.cls_mobile"]) {
    assert.match(got[id].could_not_check, /names no site: set params\.origin .* or params\.site_dir/, id);
    assert.equal("value" in got[id], false, id);
  }
  assert.equal(got["design.raw_px"].value, 8);
  // The template's own defaults: no site, and no src/ in this fixture.
  const bare = await collect({ root: join(fixtures, "root"), mode: "ci" });
  for (const t of targets) assert.equal(typeof bare[t.id].could_not_check, "string", t.id);
  assert.match(bare["design.raw_hex"].could_not_check, /no src under/);
});

test("a built static site: served from disk, never from Google, and a folder with no build says so", async () => {
  const usability = join(here, "..", "..", "fixtures", "usability");
  const site = siteFor({ site_dir: "site" }, usability);
  assert.equal(site.origin, STATIC_ORIGIN);
  assert.equal(site.psi, false);
  assert.equal(siteFor({ site_dir: "site" }, usability), site, "one site object per folder, so collectors share its cache");
  assert.match(siteFor({ site_dir: "nowhere" }, usability).error, /no built site in nowhere/);
  assert.equal(siteFor({ origin: "https://example.test", site_dir: "site" }, usability).origin, "https://example.test", "production wins");
  // Without a browser, the lab cannot measure: could_not_check, and PSI was never asked.
  const got = await collect({ root: join(fixtures, "root"), mode: "ci", params: FIXTURE, site: { ...site, launch: async () => { throw new Error("no browser"); } } });
  assert.match(got["design.lcp_mobile"].could_not_check, /PageSpeed Insights: not a public URL \(a built static site\); lab: no browser/);
});

test("serveStatic answers like a static host and never leaves its folder", async () => {
  const dir = join(here, "..", "..", "fixtures", "usability", "site");
  const at = (path) => serveStatic(dir, `${STATIC_ORIGIN}${path}`);
  const home = at("/");
  assert.equal(home.status, 200);
  assert.match(home.headers.get("content-type"), /text\/html/);
  const privacy = at("/privacy");
  assert.equal(privacy.status, 301, "a folder without its slash redirects to it");
  assert.equal(privacy.headers.get("location"), "/privacy/");
  assert.equal(at("/feed.json").headers.get("content-type"), "application/json");
  assert.equal(at("/missing-page/").status, 404);
  assert.equal(at("/%2e%2e%2f%2e%2e%2fdesign%2fpsi.json").status, 404, "a path outside the folder is not served");
});

test("targets/design.json: params are generic, and goals cite their public source", () => {
  assert.equal(targets.filter((t) => t.params).length, 1, "one params block");
  assert.equal(PARAMS.origin, "");
  assert.equal(PARAMS.site_dir, "");
  assert.equal(PARAMS.tokens, null);
  assert.deepEqual(PARAMS.widths, [1280, 375]);
  for (const t of targets) assert.match(t.source, /^(state|latest): /, `${t.id} source names its basis`);
  assert.match(def("design.lcp_mobile").goal_source, /web\.dev/);
  assert.match(def("design.cls_mobile").goal_source, /web\.dev/);
  assert.match(def("design.contrast_violations").goal_source, /WCAG 2\.2 AA, Success Criterion 1\.4\.3/);
});

test("design.mjs, usability.mjs and site-lib.mjs name no site of their own", () => {
  for (const file of ["design.mjs", "usability.mjs", "site-lib.mjs"]) {
    const src = readFileSync(join(here, file), "utf8");
    for (const p of ["site/src", "brand_tokens", "/rankings/", "ways.ts", "map.csv", "http://", ".org"]) {
      assert.ok(!src.includes(p), `${file} names ${p}; move it to a param`);
    }
  }
});
