// The source scan, design tokens and PageSpeed Insights for the site collectors (site-lib.mjs).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { PSI_ENDPOINT, PSI_QUOTA_SPENT, firstLine, now, once } from "./site-base.mjs";
import { stripAll } from "../lib/strip.mjs";

// ---------- source scan: raw px and hex outside the tokens ----------

// Every file under a folder ending in one of exts, sorted, skipping node_modules.
function listFiles(dir, exts, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules") listFiles(p, exts, out);
    else if (entry.isFile() && exts.some((x) => entry.name.endsWith(x))) out.push(p);
  }
  return out;
}

// Comments describe values; they do not paint them. Line comments only count
// when they start a line, so a URL's "//" survives.
function stripComments(text) {
  return stripAll(text.replace(/\/\*[\s\S]*?\*\//g, ""), /<!--[\s\S]*?-->/g).replace(/^\s*\/\/.*$/gm, "");
}

const PX = /(?<![\w.#])\d*\.?\d+px\b/g;
const HEX = /(?<![\w&#/-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
// A fragment link or id is not a color, even when it spells one (#add, #fade).
const NOT_A_COLOR = /(?:href|id|for|xlink:href|aria-[a-z]+|to)\s*=\s*["'{`]?$/i;

// dirs: params.src_dirs. exts: params.scan_extensions. exempt:
// params.raw_scan_exempt, [{ file, line?, why }]: a file with no `line` is
// left out whole (a generated token file, say); with `line`, a pattern, only
// the lines it matches are.
export function scanRawValues(root, { dirs = [], exts = [], exempt = [] } = {}) {
  if (!dirs.length) return { error: "params.src_dirs names no source folder" };
  const missing = dirs.filter((d) => !existsSync(join(root, d)));
  if (missing.length) return { error: `no ${missing.join(", ")} under ${root}` };
  const px = { total: 0, byFile: {} };
  const hex = { total: 0, byFile: {} };
  for (const file of dirs.flatMap((d) => listFiles(join(root, d), exts))) {
    const rel = relative(root, file).split("\\").join("/");
    const rules = exempt.filter((x) => x.file === rel);
    if (rules.some((x) => !x.line)) continue;
    const lineRules = rules.map((x) => new RegExp(x.line));
    for (const line of stripComments(readFileSync(file, "utf8")).split("\n")) {
      if (lineRules.some((re) => re.test(line))) continue;
      tally(px, rel, line.match(PX)?.length ?? 0);
      tally(hex, rel, [...line.matchAll(HEX)].filter((m) => !NOT_A_COLOR.test(line.slice(0, m.index))).length);
    }
  }
  return { px, hex };
}

function tally(into, rel, n) {
  if (!n) return;
  into.total += n;
  into.byFile[rel] = (into.byFile[rel] ?? 0) + n;
}

// ---------- tokens ----------

// spec: params.tokens, { file, colors, type, type_prefix }. file is YAML or
// JSON. colors is the dot path of the color group: every hex leaf under it,
// or a design-token { $value }, is a color token. type is the dot path of the
// type group: each key there starting with type_prefix holds a rem or px size
// of the type scale.
export function readTokens(root, spec) {
  if (typeof spec?.file !== "string") return { error: "params.tokens names no design token file" };
  const name = spec.file;
  const file = join(root, name);
  if (!existsSync(file)) return { error: `no ${name}` };
  try {
    const text = readFileSync(file, "utf8");
    const doc = /\.json$/i.test(name) ? JSON.parse(text) : parseYaml(text);
    const at = (p) => String(p ?? "").split(".").filter(Boolean).reduce((o, k) => o?.[k], doc);
    const value = (v) => (v && typeof v === "object" && "$value" in v ? v.$value : v);
    const leaves = (node) =>
      Object.values(node ?? {}).flatMap((v) => (v && typeof v === "object" && !("$value" in v) ? leaves(v) : [value(v)]));
    const colors = new Set(leaves(at(spec.colors)).map(hexToKey).filter(Boolean));
    const type = Object.entries(at(spec.type) ?? {})
      .map(([k, v]) => [k, String(value(v))])
      .filter(([k, v]) => k.startsWith(spec.type_prefix ?? "") && /^[\d.]+(rem|px)$/.test(v))
      .map(([, v]) => ({ size: parseFloat(v), unit: v.endsWith("rem") ? "rem" : "px" }));
    if (!colors.size || !type.length) return { error: `${name} has no ${spec.colors} colors or ${spec.type}.${spec.type_prefix ?? ""}* sizes` };
    return { colors, type };
  } catch (e) {
    return { error: `${name} did not parse: ${firstLine(e)}` };
  }
}

// A #rgb or #rrggbb color as "r,g,b", or null.
export function hexToKey(hex) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).join(",");
}

// Computed colors arrive as rgb(), rgba() or, after color-mix(), color(srgb).
// The key is the rgb triple; alpha is returned apart so a token at partial
// opacity still reads as the token.
export function colorKey(css) {
  let m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/i.exec(css);
  if (m) return { key: [m[1], m[2], m[3]].map((x) => Math.round(+x)).join(","), alpha: alphaOf(m[4], m[5]) };
  m = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+)(%?))?\s*\)$/i.exec(css);
  if (m) return { key: [m[1], m[2], m[3]].map((x) => Math.round(+x * 255)).join(","), alpha: alphaOf(m[4], m[5]) };
  return { key: css, alpha: 1 };
}
// A color's alpha from 0 to 1, given as a fraction or a percent.
const alphaOf = (a, pct) => (a === undefined ? 1 : pct ? +a / 100 : +a);

// ---------- PageSpeed Insights ----------

// The PageSpeed Insights request URL for one page.
function psiRequestUrl(pageUrl) {
  return `${PSI_ENDPOINT}?url=${encodeURIComponent(pageUrl)}&strategy=mobile&category=performance`;
}

// The vitals in a PageSpeed Insights answer; throws on a Lighthouse error.
export function parsePsi(json) {
  const lh = json?.lighthouseResult;
  if (!lh) throw new Error("response has no lighthouseResult");
  if (lh.runtimeError?.code && lh.runtimeError.code !== "NO_ERROR") {
    throw new Error(`Lighthouse runtimeError ${lh.runtimeError.code}`);
  }
  const num = (id) => {
    const v = lh.audits?.[id]?.numericValue;
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`audit ${id} has no numericValue`);
    return v;
  };
  return {
    lcp_ms: num("largest-contentful-paint"),
    cls: num("cumulative-layout-shift"),
    tbt_ms: num("total-blocking-time"),
    lighthouse: lh.lighthouseVersion,
  };
}

// One keyless call per page, one at a time: the keyless quota is small, and a
// 429 is a could_not_check for that page, not a slow page.
export function psiPages(site, paths) {
  return once(site, `psi ${paths.join(" ")}`, async () => {
    const pages = {};
    let spent = null;
    for (const path of paths) {
      // A 429 means the day's keyless quota is gone, so the rest would 429
      // too: stop calling rather than spend more requests to learn it.
      if (spent) {
        pages[path] = { error: spent };
        continue;
      }
      const url = new URL(path, site.origin).href;
      try {
        const res = await site.fetch(psiRequestUrl(url), { signal: AbortSignal.timeout(120_000) });
        if (!res.ok) {
          await res.body?.cancel();
          if (res.status === 429) spent = PSI_QUOTA_SPENT;
          pages[path] = { error: spent ?? `HTTP ${res.status}` };
          continue;
        }
        pages[path] = { ...parsePsi(await res.json()), read_at: now() };
      } catch (e) {
        pages[path] = { error: firstLine(e) };
      }
    }
    return pages;
  });
}
