#!/usr/bin/env node
// Runs every collector, the template's and the repo's own, against the repo
// in the current folder and writes what they read.
//
//   node <code-os>/quality/collect.mjs [--config FILE]           CI: writes <data>/latest.json
//   node <code-os>/quality/collect.mjs [--config FILE] --local   a session on a
//       maintainer's machine: writes <data>/local.json and <history>/<date>.json
//   node <code-os>/quality/collect.mjs [--config FILE] --out RUN    CI, the run
//       to RUN only (actions/pages mode collect uploads it)
//   node <code-os>/quality/collect.mjs [--config FILE] --from RUN   no collector:
//       RUN, a CI run another job wrote, becomes <data>/latest.json (mode render)
//   --only NAME   runs one collector (NAME.mjs) alone; a --local run merges
//       its metrics into <data>/local.json and skips the quota check
//
// Each run logs gh api rate_limit before and after (collect-quota.mjs). Under
// the API reserve, collectors that export githubApi do not run (#679). A full
// --local run stops when this hour's quota left is under a full run's need:
// the last one's api_spend in local.json, else FULL_RUN_GUESS. Every session
// on the login shares that quota, so a run that empties it stalls them all.
//
// FILE is the repo's config (config.mjs), default quality/config.json when
// the repo has one. A collector is any *.mjs in Git Crafter's quality/collectors/,
// a pack's collectors folder (packs.mjs) or the repo's, or one subfolder down, that exports
// collect(); helpers and
// *.test.mjs are skipped. The contract is in quality/collectors/README.md. A collector
// that throws turns each of its metrics into could_not_check, so one broken
// collector never blanks the page.
//
// Exit 0 written (an empty run when no collector exists yet), 2 usage error
// (bad config or targets, or a repo collector named like a template one), 3
// written, but a gate metric is worse than its goal (actions/pages fails a
// pull request on it, after the pages build; a "warn" gate never exits 3), 4
// a full --local run stopped because this hour's GitHub API quota would not
// fit it (nothing written).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { quotaLine, quotaStart, readQuotaOrNull, recordLocal, reserveFloor, reserveShort } from "./collect-quota.mjs";
import { ghClient } from "./collectors/github/github-core.mjs";
import * as lib from "./collectors/lib/index.mjs";
import { redactText } from "./collectors/lib/redact.mjs";
import { loadConfig, QUALITY } from "./config.mjs";
import { configDefs } from "./packs.mjs";
import { currentMetrics } from "./score.mjs";

function headCommit(root) {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

// Collectors at once. Git Crafter's own collectors took 250 s in all (pages.yml
// run 43110227533, 2026-11-11), so four at once could never finish under
// 62 s, and the slowest, tools.mjs at 40 s, waited 45 s for a slot because it
// is last in folder order. Eight start every slow one in the first seconds.
// GitHub allows 100 concurrent requests and 900 REST points a minute
// (docs.github.com, "Rate limits for the REST API", read 2026-11-11). Whatever
// the pool, gh calls in flight stay at or under 33:
//   16  every ghClient call in the process (github-core GH_AT_ONCE), which
//       covers ci, github, insights, settings, tests, code and
//       deploy's Pages reads
//   16  tools.mjs, READS x GITHUB_GROUPS (4 x 4)
//    1  deploy's issue list, one gh call at a time
// That run spent 290 REST points, about 400 a minute at a 45 s wall.
export const POOL = 8;

// The collector files to run, the template's first, then the repo's own. Git
// keeps no empty folder, so an absent folder is "no collectors yet", not an
// error. A repo collector with a template collector's name is a usage error:
// two files would claim one targets file.
export function collectorFiles(dirs) {
  const seen = new Map();
  const files = [];
  for (const top of [...new Set(dirs.filter(Boolean).map((d) => resolve(d)))]) {
    if (!existsSync(top)) continue;
    // A collectors folder may keep each tab's files in a subfolder of its own;
    // lib/ holds the shared helpers, never a collector.
    const subs = readdirSync(top, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== "lib").map((e) => join(top, e.name)).sort();
    for (const dir of [top, ...subs]) {
      for (const file of readdirSync(dir).filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs")).sort()) {
        if (seen.has(file)) throw new Error(`collector ${file} is in both ${seen.get(file)} and ${dir}; rename the repo's own`);
        seen.set(file, dir);
        files.push({ dir, file });
      }
    }
  }
  return files;
}

// Runs the collectors in `dirs` against `root`. Each gets the params and
// targets of its own targets file (collectors/github/github.mjs → targets/github.json),
// and every file's params by file name, so a collector that needs another
// tab's settings (the docs' doc set, say) reads them where they live instead
// of a copy that drifts: collect({ root, mode, data, params, targets, allParams, lib }); data is the
// repo's data folder (config data), absolute. A collector whose targets are all
// off (dropped, or on a tab the repo does not show) does not run; one with no
// targets file runs, and its ids reach the page only if a targets file
// defines them. reserve, the reason the run is under the API reserve
// (collect-quota.mjs reserveShort), stops each collector that exports
// githubApi: its metrics are could_not_check with that reason.
export async function runCollectors({ root, mode, dirs, defs, all = defs, params = {}, data = resolve(root, "quality/data"), pool = POOL, only = null, reserve = null, label = (dir, file) => `${relative(root, dir) || "."}/${file}` }) {
  const files = collectorFiles(dirs).filter((f) => !only || f.file === `${only}.mjs`);
  if (only && !files.length) throw new Error(`--only ${only}: no collector ${only}.mjs`);
  const seconds = {};
  const one = async ({ dir, file }) => {
    const stem = file.replace(/\.mjs$/, "");
    const source = label(dir, file);
    const own = defs.filter((d) => d.file === `${stem}.json`);
    if (!own.length && all.some((d) => d.file === `${stem}.json`)) return null;
    const started = Date.now();
    try {
      // The import sits inside the try: a collector whose dependency fails to
      // load must blank only its own metrics, never the page.
      const mod = await import(pathToFileURL(join(dir, file)).href);
      if (typeof mod.collect !== "function") return null;
      if (reserve && mod.githubApi) {
        console.error(`${file}: skipped, ${reserve}`);
        return unread(own, reserve, source);
      }
      const got = await mod.collect({ root, mode, data: resolve(root, data), params: { ...params[`${stem}.json`] }, targets: own, allParams: structuredClone(params), lib });
      seconds[file] = (Date.now() - started) / 1000;
      console.error(`${file}: ${seconds[file].toFixed(1)} s`);
      return { metrics: entries(got, source), area: mod.area ?? stem };
    } catch (err) {
      // An error message can carry an absolute path under home (#393).
      const reason = redactText(`collector ${file} failed: ${err.message}`);
      console.error(reason);
      return unread(own, reason, source);
    }
  };
  // Up to `pool` at once; results merge in file order, so the output never
  // depends on which finished first.
  const results = new Array(files.length);
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const i = next++;
      results[i] = await one(files[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(pool, files.length) }, worker));
  const metrics = {};
  const ran = [];
  for (const r of results) {
    if (!r) continue;
    Object.assign(metrics, r.metrics);
    if (r.area) ran.push(r.area);
  }
  return { metrics, ran, seconds };
}

// The slowest collectors, as one line: the job log is not always readable, but a run's annotations are
// (gh api repos/{repo}/check-runs/{job id}/annotations), so CI shows where the collect's time went.
export function slowestLine(seconds, wall, n = 8) {
  const top = Object.entries(seconds).sort(([, a], [, b]) => b - a).slice(0, n);
  return `${wall.toFixed(1)} s in all; slowest ${top.map(([f, s]) => `${f} ${s.toFixed(1)}`).join(", ")}`;
}

// A collector that did not read: each of its own metrics could_not_check `reason`.
function unread(own, reason, source) {
  return { metrics: Object.fromEntries(own.map((def) => [def.id, { could_not_check: reason, source }])), area: null };
}

// What a collector returned, by id; an entry that is not an object could not check.
function entries(got, source) {
  const metrics = {};
  for (const [id, entry] of Object.entries(got ?? {})) {
    metrics[id] = entry && typeof entry === "object" ? entry : { could_not_check: `${source} returned no entry object`, source };
  }
  return metrics;
}

// What a run file holds: the collectors that ran and one entry per current
// definition (score.mjs currentMetrics). A collector reads its whole file at
// once, so it also returns metrics the repo dropped or keeps on a hidden tab;
// those stay out of every file this writes, latest, local and history alike.
export function runRecord({ metrics, ran, mode, defs, commit = null, now = new Date() }) {
  return { generated_at: now.toISOString(), commit, mode, collectors: ran, metrics: currentMetrics(metrics, defs, { stamp: true }) };
}

// The CLI flags: --config, --local, --out, --from and --only.
export function parseArgs(args) {
  const out = { config: null, local: false, out: null, from: null, only: null };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i].slice(2);
    if (args[i] === "--local") out.local = true;
    else if (["--config", "--out", "--from", "--only"].includes(args[i]) && args[i + 1] && !out[flag]) out[flag] = args[++i];
    else return null;
  }
  // --out and --from are CI runs: neither goes with --local or the other.
  return [out.local, out.out, out.from].filter(Boolean).length > 1 ? null : out;
}

// Exits 2 with the message when `fn` throws: a usage error, not data.
async function orExit(fn) {
  try {
    return await fn();
  } catch (err) {
    console.error(`quality: ${err.message}`);
    process.exit(2);
  }
}

// --from: copies a CI run into the data folder as latest.json.
function copyRun(args, config) {
  const run = JSON.parse(readFileSync(resolve(args.from), "utf8"));
  if (run?.mode !== "ci" || typeof run.metrics !== "object") throw new Error(`${args.from}: not a CI run from collect.mjs`);
  mkdirSync(config.data, { recursive: true });
  writeFileSync(join(config.data, "latest.json"), `${JSON.stringify(run, null, 2)}\n`);
  console.log(`wrote ${relative(config.root, join(config.data, "latest.json"))} from ${args.from}`);
}

// A history file's name: the run's UTC day, so a folder holds one run a day.
// A local run writes it here; main's CI run writes the same file to the
// quality-history branch (history-push.mjs).
export const historyName = (run) => `${run.generated_at.slice(0, 10)}.json`;

// A run as every file this writes holds it.
export const runText = (run) => `${JSON.stringify(run, null, 2)}\n`;

// Writes the run, and a local run also into history, one file a day.
function writeRun(run, out, config, mode) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, runText(run));
  if (mode !== "local") return;
  mkdirSync(config.history, { recursive: true });
  writeFileSync(join(config.history, historyName(run)), runText(run));
}

// A gate metric (a target with "gate": true) worse than its goal is a
// problem the repo must fix: each row is named, and the run, already
// written, exits 3, which actions/pages turns into a failed pull request.
// "gate": "warn" names the rows as a warning and passes: for what a tool's
// docs call a heuristic (rules/gates.md). Returns the blocking misses.
export function gateFailures(defs, metrics) {
  const worse = (d, v) => (d.direction === "lower" ? v > d.goal : v < d.goal);
  const missed = defs.filter((d) => (d.gate === true || d.gate === "warn") && Number.isFinite(metrics[d.id]?.value) && worse(d, metrics[d.id].value));
  for (const d of missed) {
    const m = metrics[d.id];
    const level = d.gate === "warn" ? "warning" : "error";
    console.error(`::${level}::${annotation(`quality: ${d.id} is ${m.value}, goal ${d.goal}: ${(m.detail ?? []).map((row) => row.label).join("; ")}`)}`);
  }
  return missed.filter((d) => d.gate === true).length;
}

// The file a run writes: --out's, else the data folder's local or latest run.
function outFile(args, config, mode) {
  return args.out ? resolve(args.out) : join(config.data, mode === "local" ? "local.json" : "latest.json");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error("usage: node quality/collect.mjs [--config FILE] [--local | --out RUN | --from RUN] [--only NAME]");
    process.exit(2);
  }
  const mode = args.local ? "local" : "ci";
  const config = await orExit(() => loadConfig({ file: args.config, ci: mode === "ci" }));
  const loaded = await orExit(() => {
    repoEnv(config, process.env, { mode });
    if (args.from) return copyRun(args, config);
    return configDefs(config, join(QUALITY, "targets"));
  });
  if (args.from) return;
  const root = config.root;
  const out = outFile(args, config, mode);
  const gh = ghClient();
  const { before, local } = await quotaStart(mode, out, args.only, gh);
  const started = Date.now();
  const { metrics, ran, seconds } = await orExit(() => runCollectors({
    root,
    mode,
    dirs: [join(QUALITY, "collectors"), ...config.packs.map((p) => p.collectors), config.collectors],
    // A dropped metric that still gates is collected, then left out of the run.
    defs: [...new Set([...loaded.defs, ...loaded.gated])],
    all: loaded.all,
    params: loaded.params,
    data: config.data,
    only: args.only,
    reserve: reserveShort(before, reserveFloor(loaded.params)),
    label: (dir, file) => (`${dir}/`.startsWith(`${resolve(QUALITY, "collectors")}/`) ? `code-os quality/${relative(QUALITY, join(dir, file))}` : `${relative(root, dir)}/${file}`),
  }));
  if (ran.length === 0) console.log("no collectors yet; writing an empty run so the page still builds");
  if (process.env.GITHUB_ACTIONS === "true" && ran.length) console.log(`::notice title=Collector seconds::${annotation(slowestLine(seconds, (Date.now() - started) / 1000))}`);

  const after = before ? await readQuotaOrNull(gh) : null;
  console.log(quotaLine(before, after));

  const kept = recordLocal(local, { metrics, ran, only: args.only, after });
  const run = { ...runRecord({ metrics: kept.metrics, ran: kept.ran, mode, defs: loaded.defs, commit: headCommit(root) }), ...kept.extra };
  writeRun(run, out, config, mode);

  // Counted over the metrics the page shows: a collector also returns the
  // ones a repo dropped or keeps on a hidden tab, since it reads its whole
  // file at once.
  const shown = loaded.defs.map((d) => metrics[d.id]);
  const read = shown.filter((m) => m && m.could_not_check === undefined).length;
  console.log(`${ran.length} collector(s), ${read} of ${shown.length} metric(s) on the page read (${Object.keys(metrics).length} returned), wrote ${relative(root, out)}`);
  if (gateFailures(loaded.gated, metrics)) process.exitCode = 3;
}

// "owner/name" from a GitHub remote URL (https, ssh or scp form), else null.
export function remoteRepo(url) {
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(url ?? "").trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

// The repo `git remote get-url origin` names in root, else null.
export function originRepo(root) {
  try {
    return remoteRepo(execFileSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return null;
  }
}

// The config's repo reaches every collector as GITHUB_REPOSITORY, the repo
// each reads when params.repo is unset; Actions sets it, a --local run on a
// local machine does not (#230). A repo the environment already names wins.
// A --local run with neither falls back to the origin remote, since the
// config names no repo since #871.
export function repoEnv(config, env = process.env, { mode = "ci", origin = () => originRepo(config?.root) } = {}) {
  if (!env.GITHUB_REPOSITORY) {
    const repo = config?.repo ?? (mode === "local" ? origin() : null);
    if (repo) env.GITHUB_REPOSITORY = repo;
  }
  return env.GITHUB_REPOSITORY ?? null;
}

// A workflow command's message, escaped as GitHub's toolkit escapes one, so a
// label holding %, CR or LF cannot end it early or start another command.
export function annotation(text) {
  return String(text).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
