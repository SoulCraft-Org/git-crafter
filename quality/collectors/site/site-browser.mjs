// Playwright passes for the site collectors (site-lib.mjs).

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { firstLine, measured, now, once, resolveFrom, serial } from "./site-base.mjs";

// ---------- Playwright ----------

// A package's entry file from the repo's own node_modules first, then from
// the ones beside these collectors. Throws when neither has it.
// Runs in the page. Self-contained: Playwright serializes it.
export function pageFacts() {
  const visible = (el) =>
    el.checkVisibility ? el.checkVisibility({ visibilityProperty: true, opacityProperty: true }) : el.getClientRects().length > 0;
  const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
  const count = (tally, key) => {
    tally[key] = (tally[key] ?? 0) + 1;
  };
  const styles = () => {
    const fontSizes = {};
    const colors = {};
    for (const el of document.body.querySelectorAll("*")) {
      if (skip.has(el.tagName) || !visible(el)) continue;
      if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
      const cs = getComputedStyle(el);
      count(fontSizes, cs.fontSize);
      count(colors, cs.color);
    }
    return { fontSizes, colors };
  };
  const action = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"]';
  const label = (n) => `${n.tagName.toLowerCase()} "${(n.textContent || n.getAttribute("aria-label") || "").trim().slice(0, 60)}"`;
  const wordsWord = (n) => n.textContent.match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu)?.length ?? 0;
  // The visible words before the first visible link, button or field.
  const beforeAction = (scope) => {
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeType === 1 && skip.has(n.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    let words = 0;
    let first = null;
    for (let n = walker.nextNode(); n && !first; n = walker.nextNode()) {
      if (n.nodeType === 1) first = n.matches(action) && visible(n) ? label(n) : null;
      else if (n.parentElement && visible(n.parentElement)) words += wordsWord(n);
    }
    return { words, first };
  };
  const main = document.querySelector("main");
  const scope = main ?? document.body;
  const { words, first } = beforeAction(scope);
  const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize);
  return { ...styles(), rootPx, hasMain: !!main, mainText: scope.innerText, wordsBeforeAction: words, firstAction: first };
}

// Runs in the page. A field is labeled when a <label>, aria-label,
// aria-labelledby or title names it. A placeholder alone does not count: it
// vanishes on input (WCAG 2.2 SC 3.3.2).
export function formFields() {
  const ignore = new Set(["hidden", "submit", "button", "reset", "image"]);
  const text = (el) => (el?.textContent ?? "").trim();
  return [...document.querySelectorAll("input, select, textarea")]
    .filter((el) => !ignore.has((el.getAttribute("type") ?? "").toLowerCase()))
    .filter((el) => !el.closest('[aria-hidden="true"]') && (el.checkVisibility?.({ visibilityProperty: true }) ?? true))
    .map((el) => {
      const labeled =
        [...(el.labels ?? [])].some((l) => text(l)) ||
        !!el.getAttribute("aria-label")?.trim() ||
        (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).some((id) => text(document.getElementById(id))) ||
        !!el.getAttribute("title")?.trim();
      return { field: el.name || el.id || el.tagName.toLowerCase(), labeled };
    });
}

// Runs in the page after axe-core is injected. target-size ships disabled in
// axe-core 4.14.0, so it is switched on here.
export async function runAxe() {
  const r = await window.axe.run(document, { rules: { "target-size": { enabled: true } }, resultTypes: ["violations"] });
  return r.violations.map((v) => ({ id: v.id, impact: v.impact, targets: v.nodes.map((n) => n.target.join(" ")) }));
}

// axe-core's script and version, from the repo's node_modules or the ones
// beside these collectors.
function axeCore(root) {
  const source = readFileSync(resolveFrom(root, "axe-core/axe.min.js"), "utf8");
  const version = JSON.parse(readFileSync(resolveFrom(root, "axe-core/package.json"), "utf8")).version;
  return { source, version };
}

// All response bytes (body plus headers) of the requests a page finished.
async function transferBytes(requests) {
  const bytes = { total: 0 };
  for (const r of requests) {
    const s = await r.sizes().catch(() => null);
    if (s) bytes.total += s.responseBodySize + s.responseHeadersSize;
  }
  return bytes;
}

// One page loaded at one width and audited with axe; { error } when it does not load.
async function auditOne(browser, url, width, axeSource, setup) {
  const mobile = width < 768;
  const context = await browser.newContext({
    viewport: { width, height: mobile ? 812 : 800 },
    isMobile: mobile,
    hasTouch: mobile,
    // A site's CSP may block inline scripts, and axe arrives as one.
    bypassCSP: true,
  });
  const page = await context.newPage();
  const requests = [];
  page.on("requestfinished", (r) => requests.push(r));
  try {
    await setup?.(context);
    const res = await page.goto(url, { waitUntil: "load", timeout: 60_000 });
    if (!res || res.status() >= 400) return { error: `HTTP ${res?.status() ?? "no response"}` };
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    const bytes = await transferBytes(requests);
    await page.addScriptTag({ content: axeSource });
    const violations = await page.evaluate(runAxe);
    const facts = await page.evaluate(pageFacts);
    return { bytes, violations, facts };
  } catch (e) {
    return { error: firstLine(e) };
  } finally {
    await context.close();
  }
}

// One page's form fields and transfer bytes at desktop width; { error } when it does not load.
async function formOne(browser, url, setup) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const requests = [];
  page.on("requestfinished", (r) => requests.push(r));
  try {
    await setup?.(context);
    const res = await page.goto(url, { waitUntil: "load", timeout: 60_000 });
    if (!res || res.status() >= 400) return { error: `HTTP ${res?.status() ?? "no response"}` };
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    return { fields: await page.evaluate(formFields), bytes: await transferBytes(requests) };
  } catch (e) {
    return { error: firstLine(e) };
  } finally {
    await context.close();
  }
}

// One browser pass, after any pass before it on this site: launches, runs
// `work(browser)`, closes. Resolves to its result or { error } when no
// browser starts.
export function browserPass(site, work) {
  return serial(site, async () => {
    let browser;
    try {
      browser = await site.launch();
    } catch (e) {
      return { error: firstLine(e) };
    }
    try {
      return { ...(await work(browser)), browser: browser.version(), read_at: now() };
    } catch (e) {
      return { error: firstLine(e) };
    } finally {
      await browser.close();
    }
  });
}

// Each key page at each width, one page at a time (params.key_pages and
// params.widths). Resolves to { pages: { "<path>@<width>": result }, axe,
// browser, read_at } or { error } when no browser starts.
export function audit(site, { pages, widths }, root) {
  return once(site, `audit ${pages.join(" ")} @ ${widths.join(" ")}`, async () => {
    if (site.runAudit) return site.runAudit();
    return browserPass(site, async (browser) => {
      const axe = axeCore(root);
      const out = {};
      for (const path of pages) {
        for (const width of widths) out[`${path}@${width}`] = await auditOne(browser, new URL(path, site.origin).href, width, axe.source, site.setup);
      }
      return { pages: out, axe: axe.version };
    });
  });
}

// Runs in the page: what Tab focused. null when focus is on nothing, as when
// it leaves the page; else the link as an absolute URL without its hash (""
// for an element that is no link), and whether it is the first element Tab
// focused since the last reset, so a pass that wraps around can stop.
function focusedLink() {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const first = (window.__tabFirst ??= el) === el;
  const a = el.closest("a[href]");
  return { link: a ? a.href.split("#")[0] : "", first };
}

// Each task done by keyboard alone, in Chrome at 1280 px from a fresh load of
// its first page: on each page of its route, Tab until the link that leads on
// has focus, then Enter, which must land on the route's next page. A last hop
// that leaves the site is reached by Tab and never followed. Tab stops at the
// link, when focus leaves the page, or when it wraps to the first element it
// focused; MAX_TABS presses before any of those leaves the task unread.
// Resolves to { tasks: [{ status, hop, landed, error }], read_at }, one per
// route, or { error } when no browser starts. status is done, missed (Tab
// never reached the link), wrong (Enter landed elsewhere), capped or error.
export const MAX_TABS = 2000;
// Each route followed by keyboard alone, once per site and route list.
export function keyboardPass(site, routes) {
  return once(site, `keyboard ${JSON.stringify(routes)}`, async () => {
    if (site.runKeyboard) return site.runKeyboard(routes);
    return browserPass(site, async (browser) => {
      const tasks = [];
      for (const { hops } of routes) {
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        try {
          await site.setup?.(context);
          const page = await context.newPage();
          await page.goto(new URL(hops[0].from, site.origin).href, { waitUntil: "load", timeout: 60_000 });
          tasks.push(await followRoute(page, hops, site.maxTabs ?? MAX_TABS));
        } catch (e) {
          tasks.push({ status: "error", error: firstLine(e) });
        } finally {
          await context.close();
        }
      }
      return { tasks };
    });
  });
}

// Follows a route's hops by Tab and Enter; the status, and the hop where it stopped.
async function followRoute(page, hops, maxTabs) {
  for (const [hop, { link, to }] of hops.entries()) {
    const status = await tabTo(page, link, maxTabs);
    if (status !== "reached") return { status, hop };
    if (to === null) break;
    const before = page.url().split("#")[0];
    await Promise.all([page.waitForURL((u) => u.href.split("#")[0] !== before, { timeout: 30_000 }), page.keyboard.press("Enter")]);
    const landed = new URL(page.url()).pathname;
    if (landed !== to) return { status: "wrong", hop, landed };
  }
  return { status: "done" };
}

// Presses Tab until the link has focus, up to maxTabs times.
async function tabTo(page, link, maxTabs) {
  await page.evaluate(() => {
    window.__tabFirst = undefined;
  });
  for (let i = 0; i < maxTabs; i++) {
    await page.keyboard.press("Tab");
    const at = await page.evaluate(focusedLink);
    if (at?.link === link) return "reached";
    if (i > 0 && (at === null || at.first)) return "missed";
  }
  return "capped";
}

// Each form page loaded once at 1280 px, never submitted (params.form_pages),
// cold, to network idle. Resolves to { forms: { path: { fields, bytes } |
// { error } }, read_at } or
// { error } when no browser starts.
export function forms(site, paths) {
  return once(site, `forms ${paths.join(" ")}`, async () => {
    if (site.runAudit) {
      const rec = await site.runAudit();
      return rec.error ? rec : { forms: rec.forms ?? {}, read_at: rec.read_at };
    }
    return browserPass(site, async (browser) => {
      const out = {};
      for (const path of paths) out[path] = await formOne(browser, new URL(path, site.origin).href, site.setup);
      return { forms: out };
    });
  });
}

// Splits per-page results into the ones that loaded and a note naming the
// ones that did not, grouped by reason, for the metric's source line.
export function okPages(entries) {
  const ok = entries.filter(([, r]) => r && !r.error);
  const failed = new Map();
  for (const [key, r] of entries) {
    if (r && !r.error) continue;
    const why = r?.error ?? "not read";
    failed.set(why, [...(failed.get(why) ?? []), key]);
  }
  const note = [...failed].map(([why, keys]) => `${keys.join(", ")} (${why})`).join("; ");
  return { ok, note: note ? `; not measured: ${note}` : "" };
}
