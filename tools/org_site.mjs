// The site's Quality data, from disk or the contents API, and the metrics
// copied from it.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { overlayTargets, readTargetFiles } from "../quality/overlay.mjs";

import { isMeasured, notMeasured, ORG, SITE_REPO, TEMPLATE_TARGETS } from "./org_base.mjs";

// The template's targets with the site's laid over them, as definitions; why when the overlay refuses.
function siteDefs(site, targets) {
  try {
    return { defs: overlayTargets(readTargetFiles(TEMPLATE_TARGETS), targets === TEMPLATE_TARGETS ? [] : readTargetFiles(targets)).entries.filter((d) => d.drop !== true), defsError: null };
  } catch (err) {
    return { defs: [], defsError: `${site.targets}: ${err.message}` };
  }
}

// The metrics of the site's data files, a measured entry replacing an unmeasured one of the same id.
function diskMetrics(base, site) {
  const runs = site.data.map((f) => join(base, f)).filter(existsSync).map((f) => JSON.parse(readFileSync(f, "utf8")).metrics ?? {});
  if (!runs.length) throw new Error(`none of ${site.data.join(", ")} under ${site.root}`);
  const metrics = {};
  for (const run of runs) {
    for (const [id, e] of Object.entries(run)) if (!metrics[id] || (!isMeasured(metrics[id]) && isMeasured(e))) metrics[id] = e;
  }
  return metrics;
}

// GITHUB_SHA, else the folder's HEAD; null when neither is known.
function headCommit(base, exec) {
  let commit = process.env.GITHUB_SHA ?? null;
  try {
    commit ??= exec("git", ["-C", base, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {}
  return commit;
}

function pagesUrlOf(gh, site) {
  try {
    return gh?.rest(`repos/${ORG}/${site.repo}/pages`, ".html_url | @json") ?? null;
  } catch {
    return null;
  }
}

// The site's data read from disk, for a run inside the site's own checkout:
// on a pull request that is the branch's data, not main's. Each id comes from
// the first file in site.data where it is measured, else from the first file
// that has it, so CI's fresh latest.json can sit ahead of the committed
// local.json. A missing file is skipped; no file at all is a read error. A
// targets folder the template overlay refuses (an older one of full
// definitions) leaves the copied metrics unrated, with defs_error saying
// why; the numbers still read.
export function readSiteFromDisk(root, site, gh = null, exec = execFileSync) {
  const base = join(root, site.root);
  const { defs, defsError } = siteDefs(site, resolve(base, site.targets));
  const metrics = diskMetrics(base, site);
  const commit = headCommit(base, exec);
  return { repo: site.repo, defs, data: { metrics }, commit: commit ?? "unknown", pagesUrl: pagesUrlOf(gh, site), ...(defsError ? { defs_error: defsError } : {}) };
}

// The site's committed Quality data through the contents API at main: the
// repo it reads is the repo every label names.
export function fetchSite(gh, repo = SITE_REPO) {
  if (!repo) throw new Error("no site repo: set CODE_OS_SITE_REPO or the org config's site_repo");
  const base = `repos/${ORG}/${repo}/contents/quality`;
  const files = gh.rest(`${base}/targets?ref=main`, '[.[] | select(.name | endswith(".json")) | .name]');
  const defs = overlayTargets(readTargetFiles(TEMPLATE_TARGETS), files.map((f) => ({ file: f, list: JSON.parse(gh.raw(`${base}/targets/${f}?ref=main`)) }))).entries.filter((d) => d.drop !== true);
  const data = JSON.parse(gh.raw(`${base}/data/local.json?ref=main`));
  const commit = gh.rest(`repos/${ORG}/${repo}/commits/main`, ".sha | @json");
  let pagesUrl = null;
  try {
    pagesUrl = gh.rest(`repos/${ORG}/${repo}/pages`, ".html_url | @json");
  } catch {}
  return { repo, defs, data, commit, pagesUrl };
}

// Every metric id a Process doc names, wherever it sits: a metric, a metrics
// list, or a usage, share or also field.
export function namedIds(doc, out = new Set()) {
  if (Array.isArray(doc)) doc.forEach((v) => namedIds(v, out));
  else if (doc && typeof doc === "object")
    for (const [k, v] of Object.entries(doc)) {
      if (["metric", "metrics", "usage", "share", "also"].includes(k)) [v].flat().forEach((id) => typeof id === "string" && out.add(id));
      namedIds(v, out);
    }
  return out;
}

// Ids goals.json and the repo's maps name, so a copied site metric is one the
// pages use.
export function referencedIds(docs) {
  const steps = (docs.maps?.maps ?? []).flatMap((m) => m.steps ?? []);
  return new Set([...docs.goals.outcomes.flatMap((o) => o.goals.flatMap((g) => g.metrics)), ...steps.map((s) => s.metric)].filter(Boolean));
}

// The site's Claude tab, copied under its own ids. The site's blockers.* and
// simplicity.* stay behind: they measure the site's repo, and Git Crafter's page
// shows Git Crafter's own, which its own run of the quality template will write
// (orchestrator, 2026-11-03).
export const SITE_OWN = ["claude."];

// The site's Tokens tab splits this account's Claude tokens by repo
// (by_repo). Git Crafter's page shows its own row: each tokens.* value for this
// repo alone, with the site's goal. An account-wide entry, with no by_repo
// (the weekly plan), stays behind.
// In Actions it is the repo the run is for; elsewhere Git Crafter's own name.
export const OWN_REPO = process.env.GITHUB_REPOSITORY?.split("/")[1] || "git-crafter";
// One tokens.* entry narrowed to this repo's row of by_repo, with the site's goal.
function tokenEntry(id, entry, site, repo) {
  const def = site.defs.find((d) => d.id === id);
  const v = entry.by_repo[repo];
  const base = { label: def?.label ?? id, unit: def?.unit, ...(def ? { target: siteTarget(def, site.repo ?? SITE_REPO) } : {}), source: `${ORG}/${site.repo ?? SITE_REPO}@${site.commit.slice(0, 7)} quality/data/local.json ${id}, the ${repo} row of by_repo: ${entry.source}` };
  return Number.isFinite(v) ? { ...base, value: v, read_at: entry.read_at } : { ...base, could_not_check: `the site's split has no ${repo} value${entry.could_not_check ? ` (${entry.could_not_check})` : ""}` };
}

// The site's tokens.* metrics, as this repo's row of each.
export function ownTokens(site, repo = OWN_REPO) {
  const metrics = {};
  for (const [id, entry] of Object.entries(site.data.metrics ?? {})) {
    if (id.startsWith("tokens.") && entry?.by_repo) metrics[id] = tokenEntry(id, entry, site, repo);
  }
  return metrics;
}

const siteTarget = (def, from = SITE_REPO, dir = "quality/targets") => ({ direction: def.direction, goal: def.goal, near: def.near, unit: def.unit, goal_source: `${from} ${dir}/${def.file}: ${def.goal_source ?? ""}` });

// Each map step's metric from the repo's own Quality run, rated by that
// page's goal. A step its run does not measure reads not measured with why;
// another repo's number never stands in.
export function ownSteps(own, ids, spec, why = null) {
  const metrics = {};
  for (const id of ids) {
    const e = own?.data.metrics?.[id];
    const def = own?.defs.find((d) => d.id === id);
    const src = `${ORG}/${spec.repo}${own ? `@${own.commit.slice(0, 7)}` : ""} ${spec.data.join(" or ")}`;
    metrics[id] = e
      ? { label: def?.label ?? id, ...e, unit: e.unit ?? def?.unit, ...(def ? { target: siteTarget(def, spec.repo, spec.targets) } : {}), source: `${src} ${id}: ${e.source}`, copied_from: spec.repo }
      : notMeasured(own ? `${spec.repo}'s Quality run does not measure it` : `could not read ${spec.repo}'s Quality run: ${why}`, src);
  }
  return metrics;
}

// claude.* entries and any other id the pages name (each map step's metric),
// the site's tests.* and its flow (ci.latest_flow, or ci.flow before the
// rename; drop ci.flow, here and below, once the site reports
// ci.latest_flow, with the old key in tests/pages-collect.test.mjs's finishCollect
// test), and the site.* ids the pages name, copied
// from the site's committed local.json with the site's own goal as target.
// copied_from names the repo the number belongs to, so a page never shows
// another repo's number on its own map.
// The key a site id is copied under: its own for claude.* and ids the pages name, site.<id> for the rest it carries; null when not copied.
function siteKey(id, wanted) {
  if (SITE_OWN.some((p) => id.startsWith(p)) || wanted.has(id)) return id;
  return id.startsWith("tests.") || id === "ci.latest_flow" || id === "ci.flow" || wanted.has(`site.${id}`) ? `site.${id}` : null;
}

// The site's metrics the pages want, each keyed and sourced to the site's commit.
export function siteMetrics(site, wanted, from = SITE_REPO) {
  const metrics = {};
  const src = (what) => `${ORG}/${from}@${site.commit.slice(0, 7)} ${what}`;
  for (const [id, entry] of Object.entries(site.data.metrics ?? {})) {
    const key = siteKey(id, wanted);
    if (!key) continue;
    const def = site.defs.find((d) => d.id === id);
    const target = def ? siteTarget(def, from) : undefined;
    metrics[key] = { label: def?.label ?? id, ...entry, unit: entry.unit ?? def?.unit, ...(target ? { target } : {}), source: src(`quality/data/local.json ${id}: ${entry.source}`), copied_from: from };
  }
  return metrics;
}

// The name each metric shows under on the pages. Copied site metrics carry the
// label from the site's own targets file instead.
export const LABELS = {
  "pr.latest_merge_hours": "PR open to merge, the latest",
  "pr.latest_10_merges_hours": "Hours since the 10th-latest merge",
  "pr.green_at_merge": "PRs green when merged",
  "pr.conflicts_open": "Open PRs with conflicts",
  "pr.stacked_open": "Open PRs stacked on another branch",
  "pr.open": "Open PRs",
  "pr.conflict_free_share": "Open PRs free of conflicts",
  "ci.pass_rate": "CI runs that pass",
  "tests.pass_rate": "Test runs that pass",
  "ci.cancelled_share": "CI runs cancelled",
  "ci.latest_commit_minutes": "CI run minutes, the latest green commit",
  "ci.latest_push_to_green_minutes": "Push to green CI, the latest commit",
  "deploy.success_rate": "Deploys that succeed",
  "deploy.latest_minutes": "Merge to deployed, the latest",
  "models.third_party_share": "AI commits by a third-party model",
  "security.critical_high_open": "Open critical and high alerts",
  "public.private_refs": "Private references in Git Crafter",
};
