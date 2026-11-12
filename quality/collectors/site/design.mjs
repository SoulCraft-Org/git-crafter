// Design tab, measured half: how well the site looks (raw values outside the
// tokens, off-scale type and off-token color as rendered, contrast) and how
// fast it renders (LCP, CLS, bytes). A review file supplies the judgment
// scores. Reads go through site-lib.mjs, which the usability collector
// shares, so one run audits each page once.
//
// The site, its pages, its source folders and its token file are params of
// quality/targets/design.json; a repo with no site gets could_not_check.

import { readFileSync } from "node:fs";
import {
  audit,
  colorKey,
  couldNotCheck,
  measured,
  okPages,
  readTokens,
  scanRawValues,
  siteFor,
  toDetail,
  vitalsMetric,
  vitalsPages,
} from "./site-lib.mjs";

export const area = "design";
const TARGETS = JSON.parse(readFileSync(new URL("../../targets/design.json", import.meta.url), "utf8"));
export const PARAMS = Object.assign({}, ...TARGETS.map((t) => t.params ?? {}));
const AUDIT_IDS = ["font_sizes_off_scale", "text_colors_off_token", "contrast_violations", "total_bytes"].map((id) => `design.${id}`);
const VITALS_IDS = ["design.lcp_mobile", "design.cls_mobile"];

const round = (n, d = 0) => Math.round(n * 10 ** d) / 10 ** d;
const list = (x) => (Array.isArray(x) ? x : []);

// Every Design metric: the source scans and the site's rendered pages.
export async function collect({ root, mode, params = PARAMS, site = siteFor(params, root) } = {}) {
  void mode; // CI and local read the same sources.
  const out = {};
  const exempt = list(params.raw_scan_exempt);
  const scanSource =
    `regex over ${list(params.src_dirs).join(", ") || "params.src_dirs"} (${list(params.scan_extensions).join(", ")}) with comments stripped` +
    (exempt.length ? `; excludes ${exempt.map((x) => `${x.file}${x.line ? " (one line)" : ""}: ${x.why}`).join("; ")}` : "");

  const scan = scanRawValues(root, { dirs: list(params.src_dirs), exts: list(params.scan_extensions), exempt });
  for (const kind of ["hex", "px"]) {
    out[`design.raw_${kind}`] = scan.error
      ? couldNotCheck(scan.error, scanSource)
      : measured(scan[kind].total, scanSource, toDetail(Object.entries(scan[kind].byFile)));
  }

  if (site.error) {
    for (const id of [...AUDIT_IDS, ...VITALS_IDS]) out[id] = couldNotCheck(site.error, "params.origin or params.site_dir");
    return out;
  }
  const pages = list(params.key_pages);
  const widths = list(params.widths);
  const auditSource = `Playwright (Chrome) on ${site.origin}, key pages at ${widths.map((w) => `${w}`).join(" and ")} px`;
  const [run, vitals] = await Promise.all([audit(site, { pages, widths }, root), vitalsPages(site, pages)]);
  Object.assign(out, fromAudit(run, readTokens(root, params.tokens), params.tokens, auditSource), fromVitals(vitals, pages.length));
  return out;
}

function fromAudit(run, tokens, spec, source) {
  if (run.error) return Object.fromEntries(AUDIT_IDS.map((id) => [id, couldNotCheck(run.error, source)]));
  const { ok, note } = okPages(Object.entries(run.pages));
  if (!ok.length) return Object.fromEntries(AUDIT_IDS.map((id) => [id, couldNotCheck(`no key page loaded${note}`, source)]));
  return {
    ...offTokenMetrics(ok, tokens, { spec, source, note, read_at: run.read_at }),
    "design.contrast_violations": contrastMetric(ok, run, source, note),
    "design.total_bytes": bytesMetric(ok, run.read_at, source, note),
  };
}

// Off-scale type and off-token color, counted as distinct computed values.
function offTokenMetrics(ok, tokens, { spec, source, note, read_at }) {
  if (tokens.error) {
    return { "design.font_sizes_off_scale": couldNotCheck(tokens.error, source), "design.text_colors_off_token": couldNotCheck(tokens.error, source) };
  }
  const { sizes, colors } = offTokenCounts(ok, tokens);
  return {
    "design.font_sizes_off_scale": measured(
      sizes.size,
      `${source}: distinct computed font-size of visible text, vs ${spec.type}.${spec.type_prefix ?? ""}* in ${spec.file} (±0.5 px); detail is elements per size${note}`,
      toDetail(sizes, "elements"),
      read_at,
    ),
    "design.text_colors_off_token": measured(
      colors.size,
      `${source}: distinct computed text color (rgb, any alpha), vs ${spec.colors}.* in ${spec.file}; detail is elements per color${note}`,
      toDetail(colors, "elements"),
      read_at,
    ),
  };
}

// Distinct off-scale font sizes and off-token colors, with elements per value.
function offTokenCounts(ok, tokens) {
  const sizes = new Map();
  const colors = new Map();
  for (const [, r] of ok) {
    const scale = tokens.type.map((t) => (t.unit === "rem" ? t.size * r.facts.rootPx : t.size));
    for (const [size, n] of Object.entries(r.facts.fontSizes)) {
      if (scale.some((px) => Math.abs(px - parseFloat(size)) <= 0.5)) continue;
      sizes.set(size, (sizes.get(size) ?? 0) + n);
    }
    for (const [color, n] of Object.entries(r.facts.colors)) {
      const { key, alpha } = colorKey(color);
      if (alpha === 0 || tokens.colors.has(key)) continue;
      colors.set(color, (colors.get(color) ?? 0) + n);
    }
  }
  return { sizes, colors };
}

// Contrast: distinct failing elements per page, once across every width.
function contrastMetric(ok, run, source, note) {
  const axe = `axe-core${run.axe ? ` ${run.axe}` : ""}`;
  const failing = new Map();
  for (const [key, r] of ok) {
    const path = key.split("@")[0];
    const set = failing.get(path) ?? new Set();
    for (const v of r.violations.filter((v) => v.id === "color-contrast")) v.targets.forEach((t) => set.add(t));
    failing.set(path, set);
  }
  return measured(
    [...failing.values()].reduce((n, s) => n + s.size, 0),
    `${source}: ${axe} color-contrast, distinct failing elements per page across every width${note}`,
    [...failing].map(([label, s]) => ({ label, value: s.size })),
    run.read_at,
  );
}

// Transfer bytes at load, cold cache, the heaviest page and width.
function bytesMetric(ok, read_at, source, note) {
  const detail = ok.map(([label, r]) => ({ label, value: round(r.bytes.total / 1024, 1) }));
  return measured(
    Math.max(...detail.map((d) => d.value)),
    `${source}: all response bytes (body plus headers) to the load event plus network idle, fresh context; value is the heaviest page and width${note}`,
    detail,
    read_at,
  );
}

// PageSpeed Insights per page, and the lab fallback for the pages it could
// not answer; vitalsMetric labels every row and the source with its method.
function fromVitals(run, total) {
  return {
    "design.lcp_mobile": vitalsMetric(run, total, (r) => round(r.lcp_ms / 1000, 2)),
    "design.cls_mobile": vitalsMetric(run, total, (r) => round(r.cls, 3)),
  };
}
