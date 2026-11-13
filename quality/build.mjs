#!/usr/bin/env node
// Renders a repo's Quality, Speed and Consumption page, <out>/index.html: one
// page, one panel per tab the repo's config shows, each scoring quality,
// speed and consumption. Reads the template's targets with the repo's laid
// over them, the repo's data/{latest,local}.json, reviews/*.yaml and
// history/*.json, and writes the page render/page.mjs lays out.
//
//   node <code-os>/quality/build.mjs [--config FILE]
//
// Exit 0 written, 1 page over its size budget (still written, so it can be
// inspected), 2 usage error (bad config, targets or review file), 3 no data
// yet.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { parseArgs } from "./collect.mjs";
import { CONFIG_DEFAULTS, loadConfig, QUALITY } from "./config.mjs";
import { configDefs, configIdeals } from "./packs.mjs";
import { render } from "./render/page.mjs";
import { currentMetrics, loadAllReviews, loadData, mergeMetrics, newestReviews, TABS, tabGaps } from "./score.mjs";

// The drawing lives in quality/render/ (charts, layout, styles, client
// script); these two stay exported here for the self-test.
export { render };
export { fmt } from "./render/charts.mjs";

export const PAGE_BUDGET = CONFIG_DEFAULTS.budget;
// Whether the built page fits its byte budget, and its size in bytes.
export function sizeCheck(html, budget = PAGE_BUDGET) {
  const bytes = Buffer.byteLength(html, "utf8");
  return { bytes, ok: bytes <= budget };
}

// Everything the page needs, read from the repo and the template: a usage
// error throws, missing data is { code: 3 }.
// `template` is Git Crafter's quality/ folder; the self-test points it at a seed.
export function readInputs(config, { template = QUALITY } = {}) {
  const tabIds = new Set(config.tabs.map(([id]) => id));
  const { defs } = configDefs(config, join(template, "targets"));
  const ideals = configIdeals(config, join(template, "ideals"));
  // A review of a template tab the repo turned off stays on disk and off the
  // page, never a usage error.
  const reviewHistory = Object.fromEntries(Object.entries(loadAllReviews(config.reviews, new Set([...TABS.map(([id]) => id), ...tabIds]))).filter(([tab]) => tabIds.has(tab)));
  // Every run is read through the current definitions: an older file keeps
  // its dropped ids on disk, and the page never sees them.
  const current = (run) => (run && typeof run === "object" ? { ...run, metrics: currentMetrics(run.metrics, defs) } : run);
  const latest = current(loadData(join(config.data, "latest.json")));
  const local = current(loadData(join(config.data, "local.json")));
  if (!latest && !local) return { code: 3 };
  const history = [];
  for (const f of config.history && existsSync(config.history) ? readdirSync(config.history).filter((n) => n.endsWith(".json")).sort() : []) {
    try {
      history.push(current(loadData(join(config.history, f))));
    } catch (err) {
      console.error(`skipping history/${f}: ${err.message}`);
    }
  }
  return { code: 0, defs, ideals, reviewHistory, latest, local, history };
}

// Reads the targets, data and reviews in config and renders the page; a
// nonzero code means an input failed and nothing was rendered.
export function buildPage(config, { now = new Date(), template } = {}) {
  const inputs = readInputs(config, { template });
  if (inputs.code) return inputs;
  const { defs, ideals, reviewHistory, latest, local, history } = inputs;
  // Each tab needs an ideal and a metric in each category. The template's
  // self-test blocks on its own tabs; a repo's page still builds and says
  // what is missing, on the page and here.
  for (const g of tabGaps(config.tabs, defs, ideals)) console.error(`tab ${g.tab}: no ${g.missing === "ideal" ? "ideal state" : `${g.missing} metric`}`);
  const css = existsSync(config.tokens_css) ? readFileSync(config.tokens_css, "utf8") : (console.error(`${config.tokens_css} is missing; the page builds unstyled`), "");
  const html = render({
    defs,
    metrics: mergeMetrics(local, latest),
    reviews: newestReviews(reviewHistory),
    reviewHistory,
    history,
    tabs: config.tabs,
    ideals,
    meta: { commit: (latest ?? local).commit, builtAt: `${now.toISOString().slice(0, 16).replace("T", " ")} UTC`, name: config.name, repoUrl: config.repoUrl, reviews: relative(config.root, config.reviews).split(sep).join("/") },
    css,
  });
  return { code: 0, html, defs, reviewed: Object.keys(reviewHistory).length };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args || args.local || args.out || args.from) {
    console.error("usage: node quality/build.mjs [--config FILE]");
    process.exit(2);
  }
  let config;
  let page;
  try {
    config = loadConfig({ file: args.config, ci: process.env.GITHUB_ACTIONS === "true" });
    page = buildPage(config);
  } catch (err) {
    console.error(`quality: ${err.message}`);
    process.exit(2);
  }
  if (page.code === 3) {
    console.error(`no ${relative(config.root, config.data)}/latest.json or local.json; run quality/collect.mjs first`);
    process.exit(3);
  }
  mkdirSync(config.out, { recursive: true });
  const file = join(config.out, "index.html");
  writeFileSync(file, page.html);
  const size = sizeCheck(page.html, config.budget);
  const bytes = (n) => n.toLocaleString("en-US");
  console.log(`wrote ${relative(config.root, file)} (${page.defs.length} metrics, ${config.tabs.length} tabs, ${page.reviewed} reviewed tab(s), ${bytes(size.bytes)} of ${bytes(config.budget)} bytes)`);
  if (!size.ok) {
    console.error(`${relative(config.root, file)} is ${bytes(size.bytes - config.budget)} bytes over its ${bytes(config.budget)}-byte budget; make rows lighter`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
