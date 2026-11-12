// Shared helpers, caching and the static site server for the site collectors (site-lib.mjs).

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";

export const PSI_ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
export const PSI_QUOTA_SPENT =
  "HTTP 429, the keyless PageSpeed Insights quota is spent (no further calls this run); " +
  "Google's own numbers need a PageSpeed Insights API key";
export const UA = "code-os-quality-collector (Quality page crawl)";
// The origin a built static site is served under, to the crawl and the
// browser alike. .invalid never resolves (RFC 2606), so nothing leaves the
// machine.
export const STATIC_ORIGIN = "https://static.invalid";

// The time now, as ISO text.
export const now = () => new Date().toISOString();
// An error's first line, cut to 300 characters.
export const firstLine = (e) => String(e?.message ?? e).split("\n")[0].slice(0, 300);

// A measured metric with its source and read time, and detail rows when any.
export function measured(value, source, detail, read_at = now()) {
  return detail?.length ? { value, detail, source, read_at } : { value, source, read_at };
}

// A could_not_check metric with its reason and source.
export function couldNotCheck(reason, source) {
  return { could_not_check: reason, source };
}

// Detail rows, largest first; ties by label, so the order does not depend on
// the file system or on which page answered first. Pass `unit` when a row
// counts something other than the headline (the core reads detail[].unit).
export function toDetail(entries, unit) {
  return [...entries]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([label, value]) => (unit === undefined ? { label, value } : { label, value, unit }));
}

// ---------- caching ----------

const caches = new WeakMap();
// Runs fn once per site and key, and returns that same promise after.
export function once(site, key, fn) {
  if (!caches.has(site)) caches.set(site, new Map());
  const cache = caches.get(site);
  if (!cache.has(key)) cache.set(key, Promise.resolve().then(fn));
  return cache.get(key);
}

// One browser pass at a time per site, in the order asked: a second browser
// busy at once would slow the very pages being timed, and the machine may be
// small. Each pass resolves to data or { error }, so the chain never rejects.
const queues = new WeakMap();
// Runs fn after every earlier serial call on the same site.
export function serial(site, fn) {
  const next = (queues.get(site) ?? Promise.resolve()).then(fn);
  queues.set(site, next);
  return next;
}

// The site the params name, one object per site and repo, so both collectors
// share its cache: params.origin (production) first, else params.site_dir (a
// built static site), else { error }.
const sites = new Map();
// The site the params name (params.origin or params.site_dir), one object per site and repo.
export function siteFor(params, root) {
  const { origin, site_dir: dir } = params ?? {};
  if (typeof origin === "string" && origin) {
    const key = `origin ${origin} ${root}`;
    if (!sites.has(key)) sites.set(key, { origin, fetch: (...a) => globalThis.fetch(...a), launch: () => launchChrome(root) });
    return sites.get(key);
  }
  if (typeof dir === "string" && dir) {
    const abs = resolve(root, dir);
    if (!existsSync(join(abs, "index.html"))) return { error: `no built site in ${dir} (no index.html); run the build first` };
    const key = `dir ${abs}`;
    if (!sites.has(key)) sites.set(key, staticSite(abs, root));
    return sites.get(key);
  }
  return { error: "this repo names no site: set params.origin (its production URL) or params.site_dir (a built static site folder)" };
}

// ---------- a built static site, served from disk ----------

const TYPES = {
  ".html": "text/html; charset=utf-8", ".json": "application/json", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".avif": "image/avif", ".gif": "image/gif", ".ico": "image/x-icon", ".woff2": "font/woff2",
  ".txt": "text/plain", ".xml": "application/xml",
};

// A Response for one URL under STATIC_ORIGIN, the way a static host answers:
// /x/ is x/index.html, /x is the file x, x.html, or a 301 to /x/ when x is a
// folder. Nothing outside `dir` is ever read. `url` is set on the Response,
// as fetch sets it.
export function serveStatic(dir, url) {
  const u = new URL(url);
  let path;
  try {
    path = decodeURIComponent(u.pathname);
  } catch {
    path = u.pathname;
  }
  const file = (rel) => {
    const abs = resolve(dir, `.${rel}`);
    if (abs !== dir && !abs.startsWith(dir + sep)) return null;
    return existsSync(abs) && statSync(abs).isFile() ? abs : null;
  };
  const answer = (abs, at) => {
    const res = abs
      ? new Response(readFileSync(abs), { headers: { "content-type": TYPES[extname(abs)] ?? "application/octet-stream" } })
      : new Response("<h1>Not found</h1>", { status: 404, headers: { "content-type": TYPES[".html"] } });
    Object.defineProperty(res, "url", { value: new URL(at, u.origin).href });
    return res;
  };
  if (path.endsWith("/")) return answer(file(`${path}index.html`), path);
  const exact = file(path) ?? file(`${path}.html`);
  if (exact) return answer(exact, path);
  if (file(`${path}/index.html`)) {
    const moved = new Response(null, { status: 301, headers: { location: `${path}/` } });
    Object.defineProperty(moved, "url", { value: new URL(path, u.origin).href });
    return moved;
  }
  return answer(null, path);
}

// A built folder served as a site, with no PageSpeed reads.
function staticSite(dir, root) {
  const fetch = async (url) => serveStatic(dir, url);
  return {
    origin: STATIC_ORIGIN,
    fetch,
    // Google cannot reach a folder on disk, so the lab measures every page.
    psi: false,
    launch: () => launchChrome(root),
    // Each browser context answers STATIC_ORIGIN from the folder.
    setup: (context) =>
      context.route(`${STATIC_ORIGIN}/**`, async (route) => {
        const res = await fetch(route.request().url());
        await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) });
      }),
  };
}

// A module resolved from the repo root, else from beside the collectors.
export function resolveFrom(root, spec) {
  try {
    return createRequire(join(root ?? process.cwd(), "noop.js")).resolve(spec);
  } catch {
    return createRequire(import.meta.url).resolve(spec);
  }
}

// Launches the installed Chrome through the repo's playwright, else playwright-core.
export async function launchChrome(root) {
  let chromium;
  // The repo's playwright first; else playwright-core beside the collectors,
  // which drives the installed Chrome and downloads no browser.
  for (const spec of ["playwright", "playwright-core"]) {
    try {
      const mod = await import(pathToFileURL(resolveFrom(root, spec)).href);
      chromium = mod.chromium ?? mod.default?.chromium;
      break;
    } catch (e) {
      if (spec === "playwright-core") throw new Error(`playwright is installed neither in the repo nor beside the collectors (${firstLine(e)})`);
    }
  }
  try {
    // Google Chrome is on GitHub's Ubuntu runners, so no browser download is
    // needed there.
    return await chromium.launch({ channel: "chrome", headless: true });
  } catch (chrome) {
    try {
      return await chromium.launch({ headless: true });
    } catch (bundled) {
      throw new Error(
        `no browser (Chrome channel: ${firstLine(chrome)}; bundled Chromium: ${firstLine(bundled)}). ` +
          "Install Google Chrome, or run npx playwright install chromium",
      );
    }
  }
}

