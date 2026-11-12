// Lab and PageSpeed vitals for the site collectors (site-lib.mjs).

import { join } from "node:path";
import { couldNotCheck, firstLine, measured, now, once } from "./site-base.mjs";
import { psiPages } from "./site-scan.mjs";
import { browserPass, okPages } from "./site-browser.mjs";

// ---------- speed: PageSpeed Insights first, then a lab fallback ----------
//
// The keyless PSI pool is shared and its daily quota runs out.
// When PSI cannot answer for a page, this collector loads that page itself
// under Lighthouse's mobile settings and reads LCP, CLS and TBT from the
// browser's own performance entries. Those are lab numbers of ours, not
// Google's, and every row and source line says which is which.

// Lighthouse's mobile settings (Lighthouse main, read 2026-11-02:
// core/config/constants.js screenEmulation.mobile, and throttling.mobileSlow4G
// from Chrome DevTools' models/trace/lantern/simulation/Constants.ts). PSI
// simulates slow 4G as 150 ms RTT and 1.6 Mbps. Lighthouse applies the same
// profile through DevTools (core/lib/emulation.js) as RTT x 3.75 request
// latency and throughput x 0.9, because a per-request delay stands in for the
// round trips of a real connection; those applied figures are used here.
export const LAB = {
  viewport: { width: 412, height: 823 },
  deviceScaleFactor: 1.75,
  cpuSlowdown: 4,
  latencyMs: 150 * 3.75,
  downloadKbps: 1.6 * 1024 * 0.9,
  uploadKbps: 750 * 0.9,
  // The window closes at the first 5 s with no long task after load, the
  // quiet window Time to Interactive looks for (web.dev/articles/tti), or at
  // the cap, counted from navigation start.
  quietMs: 5000,
  capMs: 45_000,
};

// Rounds to two decimals.
const round2 = (n) => Math.round(n * 100) / 100;
export const PSI_METHOD = "PageSpeed Insights API v5, mobile (Google's Lighthouse lab, no key)";
// The source text for vitals read by the lab fallback.
function labMethod(browser) {
  return (
    "lab fallback, our numbers and not Google's: Playwright" +
    (browser ? ` on Chromium ${browser}` : "") +
    ", one cold load per page with Lighthouse's mobile settings applied through CDP (throttling.mobileSlow4G: " +
    `${LAB.cpuSlowdown}x CPU slowdown, ${LAB.latencyMs} ms request latency, ${round2(LAB.downloadKbps)} Kbps down, ` +
    `${LAB.uploadKbps} Kbps up; ${LAB.viewport.width} x ${LAB.viewport.height} px at ${LAB.deviceScaleFactor}x)`
  );
}

// LCP: the last largest-contentful-paint entry, as web-vitals 5 onLCP reports
// it (entry.startTime is the render time, or the load time when that is 0).
// The lab never prerenders and never sends input, so there is no
// activationStart to subtract and no cut-off at the first input.
export function lcpFromEntries(entries) {
  return entries?.length ? entries.at(-1).startTime : null;
}

// CLS: the largest session window of layout shifts without recent input. A
// shift joins the open window when it comes less than 1 s after the window's
// last shift and less than 5 s after its first; otherwise it opens a new one
// (web-vitals 5 LayoutShiftManager; web.dev/articles/cls).
export function clsFromShifts(shifts) {
  let max = 0;
  let value = 0;
  let first = null;
  let last = null;
  for (const s of [...(shifts ?? [])].sort((a, b) => a.startTime - b.startTime)) {
    if (s.hadRecentInput) continue;
    if (value && s.startTime - last < 1000 && s.startTime - first < 5000) {
      value += s.value;
    } else {
      value = s.value;
      first = s.startTime;
    }
    last = s.startTime;
    max = Math.max(max, value);
  }
  return max;
}

// The lab sends no input, yet Chrome flags the shifts just after it applies
// the emulated viewport as if they followed input (crbug.com/1302667). Chrome
// flags a shift only within 500 ms of that viewport change, so, as Lighthouse
// does (core/computed/metrics/cumulative-layout-shift.js), a flagged shift
// counts until the first unflagged one, and the flag holds after it.
export function labShifts(shifts) {
  let respect = false;
  return [...(shifts ?? [])]
    .sort((a, b) => a.startTime - b.startTime)
    .map((s) => {
      if (!s.hadRecentInput) respect = true;
      return s.hadRecentInput && !respect ? { ...s, hadRecentInput: false } : s;
    });
}

// TBT: each long task is clipped to the window from FCP to `endMs` first, and
// the clipped part past 50 ms counts (calculateSumOfBlockingTime in Chrome
// DevTools' models/trace/lantern/metrics/TBTUtils.ts, which Lighthouse runs;
// web.dev/articles/tbt). Long tasks come from the Long Tasks API, which
// reports main-thread tasks over 50 ms.
const BLOCKING_MS = 50;
// Total blocking time: each long task's time past BLOCKING_MS within the window.
export function tbtFromTasks(tasks, startMs, endMs) {
  if (!(endMs > startMs)) return 0;
  let sum = 0;
  for (const t of tasks ?? []) {
    const end = t.startTime + t.duration;
    if (t.duration < BLOCKING_MS || end < startMs || t.startTime > endMs) continue;
    const clipped = Math.min(end, endMs) - Math.max(t.startTime, startMs);
    if (clipped >= BLOCKING_MS) sum += clipped - BLOCKING_MS;
  }
  return sum;
}

// The blocking tasks, longest first, at most three, each with what its long
// animation frame says ran in it (Long Animation Frames API: its longest
// script and its style and layout time), so a slow page names its cause.
function blockingTasks(tasks, startMs, endMs, frames = []) {
  return (tasks ?? [])
    .filter((t) => tbtFromTasks([t], startMs, endMs) > 0)
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 3)
    .map((t) => {
      const f = frames.find((f) => f.startTime <= t.startTime + t.duration && f.startTime + f.duration >= t.startTime);
      const script = f?.scripts?.length ? f.scripts.reduce((a, b) => (b.ms > a.ms ? b : a)) : null;
      const parts = [script ? `script ${script.ms} ms ${script.who}`.trim() : "", f?.layout_ms ? `style and layout ${f.layout_ms} ms` : ""].filter(Boolean);
      return `${Math.round(t.duration)} ms at ${(t.startTime / 1000).toFixed(1)} s${parts.length ? ` (${parts.join(", ")})` : ""}`;
    });
}

// What the page observed, as three values, or { error } when it never
// painted: a page with no FCP or LCP was not measured, and that is not 0.
export function labVitals(obs) {
  if (obs?.error) return { error: obs.error };
  if (typeof obs?.fcp !== "number") return { error: "the lab saw no first-contentful-paint" };
  const lcp = lcpFromEntries(obs.lcp);
  if (lcp === null) return { error: "the lab saw no largest-contentful-paint" };
  return {
    lcp_ms: lcp,
    cls: clsFromShifts(labShifts(obs.shifts)),
    tbt_ms: tbtFromTasks(obs.tasks, obs.fcp, obs.end),
    ...blockingOf(obs),
    ...(obs.capped ? { capped: true } : {}),
  };
}

function blockingOf(obs) {
  const blocking = blockingTasks(obs.tasks, obs.fcp, obs.end, obs.frames);
  return blocking.length ? { blocking } : {};
}

// Runs in the page before any of its scripts (addInitScript). Self-contained:
// Playwright serializes it.
function observeVitals() {
  const lab = { fcp: null, lcp: [], shifts: [], tasks: [], frames: [], observers: [] };
  const watch = (type, take) => {
    try {
      const o = new PerformanceObserver((list) => list.getEntries().forEach(take));
      o.observe({ type, buffered: true });
      lab.observers.push([o, take]);
    } catch {
      // An entry type this browser lacks leaves its list empty, and
      // labVitals reports the page as not measured.
    }
  };
  watch("paint", (e) => {
    if (e.name === "first-contentful-paint") lab.fcp = e.startTime;
  });
  watch("largest-contentful-paint", (e) => lab.lcp.push({ startTime: e.startTime, size: e.size }));
  watch("layout-shift", (e) => lab.shifts.push({ startTime: e.startTime, value: e.value, hadRecentInput: e.hadRecentInput }));
  watch("longtask", (e) => lab.tasks.push({ startTime: e.startTime, duration: e.duration }));
  watch("long-animation-frame", (e) =>
    lab.frames.push({
      startTime: e.startTime,
      duration: e.duration,
      layout_ms: e.styleAndLayoutStart ? Math.round(e.startTime + e.duration - e.styleAndLayoutStart) : 0,
      scripts: (e.scripts ?? []).map((s) => ({ ms: Math.round(s.duration), who: [s.invoker, s.sourceFunctionName, (s.sourceURL ?? "").split("/").pop()].filter(Boolean).join(" ") })),
    }),
  );
  Object.defineProperty(window, "__csLab", { value: lab });
}

// Runs in the page: flushes the observers and returns what they saw so far.
function readVitals() {
  const lab = window.__csLab;
  if (!lab) return null;
  for (const [o, take] of lab.observers) o.takeRecords().forEach(take);
  const nav = performance.getEntriesByType("navigation")[0];
  return { fcp: lab.fcp, lcp: lab.lcp, shifts: lab.shifts, tasks: lab.tasks, frames: lab.frames, loadEnd: nav?.loadEventEnd ?? 0, now: performance.now() };
}

// One cold load of `url` in a fresh context under `settings`. Resolves to the
// raw observation for labVitals, or { error }. `settings.setup(context)` lets
// a test serve the page through context.route, with no port and no network.
export async function measureLab(browser, url, settings = LAB) {
  const context = await browser.newContext({
    viewport: settings.viewport,
    deviceScaleFactor: settings.deviceScaleFactor,
    isMobile: true,
    hasTouch: true,
  });
  try {
    await settings.setup?.(context);
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    // DevTools takes bytes per second; Lighthouse floors the same way.
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: settings.latencyMs,
      downloadThroughput: Math.floor((settings.downloadKbps * 1024) / 8),
      uploadThroughput: Math.floor((settings.uploadKbps * 1024) / 8),
    });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: settings.cpuSlowdown });
    await page.addInitScript(observeVitals);
    const res = await page.goto(url, { waitUntil: "load", timeout: 90_000 });
    if (!res || res.status() >= 400) return { error: `HTTP ${res?.status() ?? "no response"}` };
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    for (;;) {
      const obs = await page.evaluate(readVitals);
      if (!obs) return { error: "the lab observers did not start" };
      const busyUntil = Math.max(obs.loadEnd, ...obs.tasks.map((t) => t.startTime + t.duration));
      const capped = obs.now >= settings.capMs;
      if (obs.now - busyUntil >= settings.quietMs || capped) return { ...obs, end: obs.now, ...(capped ? { capped } : {}) };
      await page.waitForTimeout(Math.min(1000, settings.quietMs - (obs.now - busyUntil)));
    }
  } catch (e) {
    return { error: firstLine(e) };
  } finally {
    await context.close();
  }
}

// The lab pass over the pages PSI could not answer. It queues behind any
// audit pass on this site: a second browser busy at the same time would slow
// the very pages being timed. Resolves to { pages: { path: vitals | { error } },
// browser, read_at } or { error } when no browser starts.
function labPages(site, paths) {
  return once(site, `lab ${paths.join(" ")}`, async () => {
    const vitals = (run) =>
      run.error ? run : { ...run, pages: Object.fromEntries(paths.map((p) => [p, labVitals(run.pages?.[p] ?? { error: "not read" })])) };
    if (site.runLab) return vitals(await site.runLab(paths));
    return vitals(
      await browserPass(site, async (browser) => {
        const pages = {};
        for (const path of paths) pages[path] = await measureLab(browser, new URL(path, site.origin).href, { ...LAB, setup: site.setup });
        return { pages };
      }),
    );
  });
}

// PSI first, page by page. Only the pages PSI could not answer go to the lab,
// so a lab number never replaces one Google gave. A built static site is not
// on the web, so the lab measures all of it. Resolves to { pages, browser },
// each page { lcp_ms, cls, tbt_ms, via: "psi" | "lab", read_at } or { error }
// naming both reasons.
const NOT_PUBLIC = "not a public URL (a built static site)";
// Each page's vitals from PageSpeed Insights, else the lab, once per site and page list.
export function vitalsPages(site, paths) {
  return once(site, `vitals ${paths.join(" ")}`, async () => {
    const psi = site.psi === false ? Object.fromEntries(paths.map((p) => [p, { error: NOT_PUBLIC }])) : await psiPages(site, paths);
    const missed = paths.filter((p) => !psi[p] || psi[p].error);
    const lab = missed.length ? await labPages(site, missed) : { pages: {} };
    return mergeVitals(paths, psi, lab);
  });
}

// Each page's vitals from PageSpeed Insights where it answered, else from the lab.
export function mergeVitals(paths, psi, lab) {
  const pages = {};
  for (const path of paths) {
    const p = psi[path];
    if (p && !p.error) {
      pages[path] = { ...p, via: "psi" };
      continue;
    }
    const why = p?.error ?? "not read";
    const l = lab.error ? { error: lab.error } : (lab.pages?.[path] ?? { error: "not read" });
    pages[path] = l.error
      ? { error: `PageSpeed Insights: ${why}; lab: ${l.error}` }
      : { ...l, via: "lab", psi_error: why, read_at: lab.read_at };
  }
  return { pages, browser: lab.browser ?? null };
}

// The source line for one speed metric. It leads with the lab method when any
// lab page counted, because the page clamps the line to two rows.
function vitalsSource(ok, total, note, top, browser) {
  const psi = ok.filter(([, r]) => r.via !== "lab").map(([p]) => p);
  const lab = ok.filter(([, r]) => r.via === "lab");
  const why = new Map();
  for (const [p, r] of lab) why.set(r.psi_error, [...(why.get(r.psi_error) ?? []), p]);
  const parts = [];
  if (lab.length) {
    const reasons = [...why].map(([w, ps]) => `${ps.join(", ")} (${w})`).join("; ");
    parts.push(`${labMethod(browser)}, for ${lab.map(([p]) => p).join(", ")}, where PageSpeed Insights did not answer: ${reasons}`);
  }
  if (psi.length) parts.push(`${PSI_METHOD}, for ${psi.join(", ")}`);
  const capped = lab.filter(([, r]) => r.capped).map(([p]) => p);
  const capNote = capped.length ? `; the lab window reached its ${LAB.capMs / 1000} s cap on ${capped.join(", ")}` : "";
  return `${parts.join(". ")}. ${ok.length} of ${total} key pages measured; value is the worst page, ${top}${capNote}${note}`;
}

// One speed metric over the key pages, from vitalsPages(). Each detail row is
// labeled "(PSI)" or "(lab)", so a lab number never reads as Google's;
// noteOf(page) may add what the lab saw on it.
export function vitalsMetric(run, total, valueOf, noteOf = () => "") {
  const { ok, note } = okPages(Object.entries(run.pages));
  if (!ok.length) return couldNotCheck(`no key page measured${note}`, `${PSI_METHOD}, then the ${labMethod(run.browser)}`);
  const detail = ok.map(([path, r]) => ({ label: `${path} (${r.via === "lab" ? "lab" : "PSI"}${noteOf(r)})`, value: valueOf(r) }));
  const top = detail.reduce((a, b) => (b.value > a.value ? b : a));
  const read_at = ok.map(([, r]) => r.read_at).sort().at(-1);
  return measured(top.value, vitalsSource(ok, total, note, top.label, run.browser), detail, read_at);
}
