// The Code collector's production metrics: Worker CPU and wall time, bundle
// size and startup (code.mjs).

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { errorLine, firstLine, isDir, measured, readWrangler, round, unknown, unknownAll } from "./code-util.mjs";

// ---- Speed: production ----


export const CPU_SOURCE =
  "cf workers deployments list (the first is the one serving traffic), then cf sql query on logs.workersLogs: " +
  "the last params.last_requests fetch invocations since that deploy, newest first; the slowest and heaviest of them";

// The last N requests since each Worker's latest production deploy: a last-N
// basis, so a fix shows on the next deploy, old code never counts, and no
// value averages over days. The slowest and the heaviest of those requests are
// values read now, each one real request. One query per Worker: Workers Logs
// SQL refused an OR of per-Worker time ranges with a type error (422,
// 2026-11-03), needs a plain ISO time with a Z, and wants a time range on
// every query (422, 2026-11-04). Read through the cf CLI's own login and its
// default read-only profile; this code never sees a token. Only numbers are
// selected, never log text or URLs. Wall time is the Worker's own time per
// request: a timed GET of the live site reads the CDN cache and the runner's
// network distance instead.
export const WORKER_IDS = ["code.worker_cpu_max_ms", "code.worker_wall_max_ms"];
// Each Worker's highest CPU and wall time per request over its last n requests, from production.
export async function cpuTime(root, local, run, workers, n) {
  const ids = WORKER_IDS;
  const { reason, source = CPU_SOURCE, target } = cpuTarget(root, local, workers, n);
  if (reason) return unknownAll(ids, reason, source);
  const rows = [];
  const quiet = [];
  for (const name of target.names) {
    const got = await workerRequests(root, target.account, name, n, run);
    if (got.error) return unknownAll(ids, got.error, CPU_SOURCE);
    if (got.row) rows.push(got.row);
    else quiet.push(`${name} (deployed ${got.since})`);
  }
  const note = quiet.length ? `; no fetch since the deploy: ${quiet.join(", ")}` : "";
  if (!rows.length) return unknownAll(ids, `no fetch invocations in Workers Logs since the latest deploy${note}`, CPU_SOURCE);
  return { "code.worker_cpu_max_ms": worstOf(rows, "cpu", "cpuTimeMs", note), "code.worker_wall_max_ms": worstOf(rows, "wall", "wallTimeMs", note) };
}

// What the CPU read needs: the Worker target, or the reason it cannot run.
function cpuTarget(root, local, workers, n) {
  if (!(Number.isInteger(n) && n > 0)) return { reason: "params.last_requests must be a whole count above 0", source: "params.last_requests" };
  if (!workers.length) return { reason: "params.workers names no Worker folder; this repo deploys no Worker" };
  if (!local) return { reason: "Workers analytics are read in local mode only, through the cf CLI login" };
  const target = workerTarget(root, workers);
  return target ? { target } : { reason: `no account_id in ${workers[0]}/wrangler.jsonc, or no Worker name in params.workers' configs` };
}

// The Cloudflare account and Worker names the params' wrangler configs name;
// null when either is missing.
function workerTarget(root, workers) {
  const configs = workers.map((w) => readWrangler(join(root, w)));
  const account = configs[0]?.account_id;
  const names = configs.map((c) => c?.name).filter((n) => /^[\w-]+$/.test(n ?? ""));
  return /^[0-9a-f]{32}$/.test(account ?? "") && names.length ? { account, names } : null;
}

// The newest fetch requests of one Worker since its latest deploy: { row },
// { since } when it served none, or { error }.
async function workerRequests(root, account, name, n, run) {
  const dep = await run("cf", ["workers", "deployments", "list", "--worker", name, "--per-page", "1"], {
    cwd: root,
    timeoutMs: 60_000,
    env: { CLOUDFLARE_ACCOUNT_ID: account },
  });
  if (dep.missing) return { error: "the cf CLI is not on PATH" };
  if (dep.code !== 0) return { error: `cf workers deployments list failed for ${name} (${firstLine(dep.stderr || dep.stdout)})` };
  const since = latestDeploy(dep.stdout);
  if (!since) return { error: `cf workers deployments list gave no deploy time for ${name}` };
  const sql =
    "SELECT cpuTimeMs, wallTimeMs, timestamp FROM logs.workersLogs WHERE logType = 'cf-worker-event' AND invocationType = 'fetch' " +
    `AND timestamp >= '${since}' AND scriptName IN ('${name}') ORDER BY timestamp DESC LIMIT ${n} FORMAT JSON`;
  const r = await run("cf", ["sql", "query", sql, "--scope-account", account], { cwd: root, timeoutMs: 90_000 });
  if (r.code !== 0) return { error: `cf sql query failed (${firstLine(r.stderr || r.stdout)}); check cf auth whoami and the account-analytics read scope` };
  const parsed = cfJson(r.stdout);
  if (!parsed) return { error: `cf sql query gave no JSON for ${name}` };
  const requests = parsed.data ?? [];
  if (!requests.length) return { since };
  return { row: { name, since, count: requests.length, from: requests.at(-1).timestamp, cpu: mostOf(requests, "cpuTimeMs"), wall: mostOf(requests, "wallTimeMs") } };
}

// The largest number under `key` in the requests. A request missing a number
// is skipped; null when none has one. Number() reads null and "" as 0, so
// those are dropped before it.
function mostOf(requests, key) {
  const read = requests.map((q) => q[key]).filter((v) => v !== null && v !== "" && Number.isFinite(Number(v))).map(Number);
  return read.length ? Math.max(...read) : null;
}

function worstOf(rows, key, column, note) {
  const read = rows.filter((row) => row[key] !== null);
  if (!read.length) return unknown(`Workers Logs gave no ${column} number for the last requests${note}`, CPU_SOURCE);
  const detail = read.map((row) => ({ label: `${row.name} (last ${row.count} requests, from ${String(row.from).slice(0, 16)} UTC)`, value: row[key] }));
  return measured(Math.max(...detail.map((d) => d.value)), `${CPU_SOURCE}; the worst Worker${note}`, detail);
}

// The JSON in cf's output: from the first line starting with { or [ that
// parses to the end, so a "[WARNING] ..." line before it is skipped. null when
// none parses.
export function cfJson(text) {
  const lines = String(text ?? "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*[{[]/.test(lines[i])) continue;
    try {
      return JSON.parse(lines.slice(i).join("\n"));
    } catch {
      // A preamble line that only looks like JSON; try the next.
    }
  }
  return null;
}

// created_on of the first deployment cf lists (the one serving traffic), as an
// ISO time with a Z, which Workers Logs SQL takes; null when there is none.
export function latestDeploy(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const list = Array.isArray(parsed) ? parsed : (parsed?.deployments ?? parsed?.result?.deployments ?? []);
  const t = Date.parse(list[0]?.created_on ?? "");
  return Number.isFinite(t) ? new Date(Math.ceil(t / 1000) * 1000).toISOString().replace(".000Z", "Z") : null;
}


// ---- Speed: the Worker bundles ----

export const BUNDLE_SOURCE = "wrangler deploy --dry-run --outdir <tmp> in each folder of params.workers (dry run, never deploys)";

// A Worker with static assets needs its assets folder to exist before Wrangler
// will bundle. A local run before the site build has none, so it gets an
// empty stand-in: the bundle does not depend on the assets. A built folder is
// used as it is, so CI times the same step as before.
export async function workerBundles(root, run, workers) {
  const ids = ["code.worker_bundle_kb", "code.build_seconds"];
  if (!workers.length) return unknownAll(ids, "params.workers names no Worker folder; this repo deploys no Worker", BUNDLE_SOURCE);
  const rows = [];
  for (const w of workers) {
    const scratch = mkdtempSync(join(tmpdir(), "quality-wrangler-"));
    try {
      const outdir = join(scratch, "out");
      // resolve, not join: an absolute assets.directory stays as written.
      const assets = readWrangler(join(root, w))?.assets?.directory;
      const standIn = typeof assets === "string" && !isDir(resolve(root, w, assets)) ? join(scratch, "assets") : null;
      mkdirSync(outdir);
      if (standIn) mkdirSync(standIn);
      const args = ["deploy", "--dry-run", "--outdir", outdir, ...(standIn ? ["--assets", standIn] : [])];
      const r = await run(join(root, "node_modules/.bin/wrangler"), args, {
        cwd: join(root, w),
        timeoutMs: 180_000,
        env: { WRANGLER_SEND_METRICS: "false" },
      });
      if (r.missing) return unknownAll(ids, "wrangler is not installed (npm ci installs it)", BUNDLE_SOURCE);
      if (r.code !== 0) return unknownAll(ids, `${w}: wrangler dry run failed (${errorLine(r.stderr, r.stdout)})`, BUNDLE_SOURCE);
      const modules = readdirSync(outdir).filter((n) => /\.(m?js|wasm)$/.test(n));
      if (!modules.length) return unknownAll(ids, `${w}: the dry run wrote no module to its outdir`, BUNDLE_SOURCE);
      const gzip = modules.reduce((n, m) => n + gzipSync(readFileSync(join(outdir, m))).length, 0);
      rows.push({ worker: w, kb: round(gzip / 1024, 1), seconds: round(r.ms / 1000, 1) });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  return {
    // The larger Worker sets the value; each one is in the detail.
    "code.worker_bundle_kb": measured(
      Math.max(...rows.map((r) => r.kb)),
      BUNDLE_SOURCE + "; gzip of each bundled module",
      rows.map((r) => ({ label: r.worker, value: r.kb })),
    ),
    "code.build_seconds": measured(
      round(rows.reduce((n, r) => n + r.seconds, 0), 1),
      BUNDLE_SOURCE + "; wall time of the bundle step, this run",
      rows.map((r) => ({ label: r.worker, value: r.seconds })),
    ),
  };
}

// ---- Speed: Worker startup ----

// The startup time Cloudflare measured for the code serving traffic: the
// latest successful Workers Build's log, where wrangler deploy prints "Worker
// Startup Time: N ms". A latest-event value, read through the cf CLI's login
// with GETs only; nothing here uploads or deploys. A Worker deployed some
// other way has no such build, and its startup is could_not_check.
export const STARTUP_SOURCE =
  "cf workers get (the Worker's tag), cf builds list (the newest successful Workers Build), cf builds logs get: " +
  "the \"Worker Startup Time\" wrangler deploy printed";
const STARTUP_LINE = /Worker Startup Time: (\d+(?:\.\d+)?) ms/;

// The newest Workers Build's startup time for the first Worker in params.workers.
export async function workerStartup(root, local, run, workers) {
  const id = "code.worker_startup_ms";
  const no = (reason) => ({ [id]: unknown(reason, STARTUP_SOURCE) });
  if (!workers.length) return no("params.workers names no Worker folder; this repo deploys no Worker");
  if (!local) return no("Workers Builds are read in local mode only, through the cf CLI login");
  const target = workerTarget(root, workers);
  if (!target) return no(`no account_id in ${workers[0]}/wrangler.jsonc, or no Worker name`);
  const cf = (args) => run("cf", args, { cwd: root, timeoutMs: 60_000, env: { CLOUDFLARE_ACCOUNT_ID: target.account } });
  const rows = [];
  for (const name of target.names) {
    const got = await startupOf(cf, name);
    if (got.error) return no(got.error);
    rows.push(got.row);
  }
  return { [id]: measured(Math.max(...rows.map((r) => r.value)), `${STARTUP_SOURCE}; the slowest Worker`, rows) };
}

// A Worker's newest successful Workers Build: { build } or { error }.
async function newestBuild(cf, name) {
  const worker = await cf(["workers", "get", name]);
  if (worker.missing) return { error: "the cf CLI is not on PATH" };
  if (worker.code !== 0) return { error: `cf workers get failed for ${name} (${firstLine(worker.stderr || worker.stdout)})` };
  const tag = cfJson(worker.stdout)?.id;
  if (typeof tag !== "string" || !tag) return { error: `cf workers get gave no Worker tag for ${name}` };
  const list = await cf(["builds", "list", "--external-script-id", tag, "--per-page", "10"]);
  if (list.code !== 0) return { error: `cf builds list failed for ${name} (${firstLine(list.stderr || list.stdout)})` };
  const listed = cfJson(list.stdout);
  if (!listed) return { error: `cf builds list gave no JSON for ${name}` };
  const build = [listed].flat().flatMap((b) => b?.result ?? b).find((b) => b?.build_outcome === "success");
  return build ? { build } : { error: `${name} has no successful Workers Build among its last 10; a Worker deployed another way is not read` };
}

// One Worker's startup time from its newest successful Workers Build's log:
// { row } or { error }.
async function startupOf(cf, name) {
  const found = await newestBuild(cf, name);
  if (found.error) return found;
  const { build } = found;
  const logs = await cf(["builds", "logs", "get", build.build_uuid]);
  if (logs.code !== 0) return { error: `cf builds logs get failed for ${name} (${firstLine(logs.stderr || logs.stdout)})` };
  const ms = STARTUP_LINE.exec(logs.stdout ?? "")?.[1];
  if (ms == null) return { error: `the ${name} build of ${build.created_on} logged no Worker Startup Time` };
  return { row: { label: `${name} (built ${String(build.created_on).slice(0, 16)}Z)`, value: Number(ms) } };
}
