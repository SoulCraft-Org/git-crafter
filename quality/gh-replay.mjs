// gh for pages.yml (#38): a push to main saves each public read; a pull request replays that save (data read as JSON by
// hashed name, never run); report prints the live requests ci.pr_run_requests sums. Anyone signed in can download a public
// repo's artifact, so a REST read is saved only on a PUBLIC family (each 200 to a tokenless curl, 2026-11-13), never DENY.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const [MAX_AGE_H, SETTLE_MS, ISO] = [24, 30 * 60_000, /\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?)?/g];
// The method flag in each spelling gh's flag parser takes: -X GET, -XGET, -X=GET, -iXGET, --method GET, --method=GET.
const METHOD = /^(?:--method(?:=|$)|-[a-zA-Z]*X=?)(.*)$/s;
const methodOf = (args) => args.reduce((m, a, i) => { const x = METHOD.exec(a); return x ? x[1] || (args[i + 1] ?? "") : m; }, "GET");
// A GraphQL query read from a file (query=@) is unseen, so it reads as a write (#61).
// The word mutation anywhere reads as a write, so a # comment or a first query operation cannot hide one.
const MUTATION = /^(-f|-F|--field=|--raw-field=)?query=(@|[\s\S]*\bmutation\b)/;
/** Whether gh `args` only reads: gh api with no write method, input or field (GraphQL takes fields, never a mutation), or pr/issue list. */
export function readOnly(args) {
  if (args[0] === "pr" || args[0] === "issue") return args[1] === "list";
  const field = args[1] === "graphql" ? MUTATION : /^(-f|-F|--field|--raw-field|query=\s*mutation\b)/;
  return args[0] === "api" && /^get$/i.test(methodOf(args)) && args.every((a) => !/^--input(=|$)/.test(a) && !field.test(a));
}
/** The save's name for `args`: a sha256 with each date as days and each time as hours from `now`, so a window read off the clock matches a day later. */
export function keyOf(args, now = Date.now()) {
  const day = now - (now % 86_400_000);
  const rel = args.map((a) => a.replace(ISO, (m) => (m.includes("T") ? `@${Math.round((Date.parse(m) - now) / 3_600_000)}h` : `@${(Date.parse(m) - day) / 86_400_000}d`)));
  return createHash("sha256").update(JSON.stringify(rel)).digest("hex");
}
// Reads that cannot change once taken: a commit's content, a finished job's annotations, and the jobs or attempt of a run that
// ended SETTLE_MS ago. Main's next run reuses them from its last save, at most MAX_AGE_H old, so a rerun shows within a day.
const [JOBS, ATTEMPT, ANNOTATIONS, COMMIT] = [/\/actions\/runs\/\d+\/jobs\?per_page=100$/, /\/actions\/runs\/\d+\/attempts\/1$/, /\/check-runs\/\d+\/annotations$/, /\/git\/commits\/[0-9a-f]{40}$/];
const ended = (x, now) => x?.status === "completed" && now - Date.parse(x.completed_at ?? x.updated_at) > SETTLE_MS;
const jobsFinal = (body, now) => Array.isArray(body?.jobs) && body.jobs.length > 0 && body.total_count === body.jobs.length && body.jobs.every((j) => ended(j, now));
const routeOf = (args) => (args.length === 2 && args[0] === "api" && /^repos\/[^/?]+\/[^/?]+\//.test(args[1]) ? args[1] : "");
const parsed = (route, out) => { try { return route && JSON.parse(out); } catch { return null; } };
/** Whether the read `args` that printed `out` is final: a plain `gh api` route of those four kinds whose answer holds a finished run, job or commit. */
export function immutable(args, out, now = Date.now()) {
  const route = routeOf(args);
  const body = parsed(route, out);
  if (COMMIT.test(route)) return typeof body?.sha === "string";
  if (ANNOTATIONS.test(route)) return Array.isArray(body);
  if (JOBS.test(route)) return jobsFinal(body, now);
  return ATTEMPT.test(route) && ended(body, now);
}
// The first argument after `api` that is not a flag or a flag's value (#391).
const VALUE_FLAGS = new Set(["-X", "--method", "-H", "--header", "-f", "--raw-field", "-F", "--field", "-q", "--jq", "-t", "--template", "--hostname", "--input", "--cache", "-p", "--preview"]);
const pathOf = (args) => { for (let i = 1; i < args.length; i++) { if (VALUE_FLAGS.has(args[i])) i++; else if (!args[i].startsWith("-")) return args[i]; } return ""; };
/** The read's name for the by-read tally: its route past the repo, each number or commit as {}, no query. */
export const familyOf = (args) => (pathOf(args)).replace(/^\/?repos\/[^/]+\/[^/]+\/?/, "").replace(/\?.*$/, "").split("/").map((s) => (/^(\d+|[0-9a-f]{40})$/.test(s) ? "{}" : s)).join("/") || "repo";
/** The shim gh, written into `dir`. */
export const writeShim = (dir) => writeFileSync(path.join(dir, "gh"), `#!/bin/sh\nexec node "${fileURLToPath(import.meta.url)}" shim "$@"\n`, { mode: 0o755 });
// A `.` or `..` segment, or an encoded dot, could climb out of an admitted family (#42), so PUBLIC refuses each.
const PUBLIC = /^(?!.*\/logs\b)(?!.*(?:^|\/)\.\.?(?:[/?]|$))(?!.*%2[eE])\/?repos\/[^/]+\/[^/?]+(\/(actions\/(runs|workflows)|check-runs|commits|compare|contents|deployments|environments(?=\?|$)|git|issues|labels|pulls|releases|rules\/branches|rulesets|tags|community\/profile)([/?].*)?)?(\?.*)?$/;
const DENY = /dependabot|code-scanning|secret-scanning|code-quality|security-advisories|vulnerabilityAlerts|collaborators|invitations|\/protection|secrets|actions\/permissions|private-vulnerability|billing|\/hooks|\/keys|traffic/i;
// GraphQL fields the workflow token reads that a signed-out reader does not get (#42): its own view and rights
// (viewer*, refUpdateRule), deploy keys, branch protection rules, ruleset bypass actors, interaction limits, vulnerability alerts.
const TOKEN_ONLY = /\bviewer|deployKeys|branchProtectionRule|bypassActors|interactionAbility|vulnerabilityAlert|refUpdateRule/i;
const kindOf = (args) => (args[1] === "rate_limit" ? null : args[0] === "api" && args[1] !== "graphql" ? "rest" : "graphql");
const savable = (args) => readOnly(args) && (kindOf(args) === "graphql" ? !args.some((a) => TOKEN_ONLY.test(a)) : PUBLIC.test(args[1])) && !args.some((a) => DENY.test(a));
const saveFile = (args, env) => savable(args) && env.GH_TOKEN?.trim() !== (env.ADMIN_READ_TOKEN?.trim() || null) && !(env.GH_REPLAY_LIVE ?? "").split(",").some((t) => t && args.some((a) => a.includes(t))) && path.join(env.GH_REPLAY_DIR, "r", `${keyOf(args)}.json`);
const log = (env, kind, n) => appendFileSync(`${env.GH_REPLAY_DIR}.log`, `${kind} ${n}\n`);
const pagesOf = (args, out) => { try { return (args.includes("--slurp") && JSON.parse(out).length) || 1; } catch { return 1; } };
// gh's GH_DEBUG trace names each HTTP request, so a --paginate read counts every API page (#42), not a blob download;
// the trace is cut from stderr.
const TRACE = /^(?:\* Request (?:at|to|took) |\[git ).*\n?/gm;
function live(args, env) {
  const r = spawnSync(env.GH_REPLAY_REAL, args, { env: { ...env, GH_DEBUG: "1" }, stdio: ["inherit", "pipe", "pipe"], maxBuffer: 2 ** 31 });
  if (r.error) return r;
  const err = r.stderr.toString();
  return { stdout: r.stdout, stderr: err.replace(TRACE, ""), status: r.status, pages: err.match(/^\* Request to https:\/\/api\.github\.com\//gm)?.length || pagesOf(args, r.stdout) };
}
const ran = (saved, args, env) => (saved ? { stdout: Buffer.from(saved.out, "base64"), stderr: saved.err, status: saved.status } : live(args, env));
// A save that cannot be read is read live and logged, so the PR run passes and report warns (#42).
const recordPrev = (env) => env.GH_REPLAY_MODE === "record" && env.GH_REPLAY_PREV;
const savePath = (file, env) => {
  const from = file && (recordPrev(env) ? path.join(env.GH_REPLAY_PREV, "r", path.basename(file)) : env.GH_REPLAY_MODE === "replay" && file);
  return from && existsSync(from) ? from : null;
};
const readSave = (from) => { try { return JSON.parse(readFileSync(from, "utf8")); } catch { return null; } };
const wellFormed = (s) => typeof s?.out === "string" && typeof s.err === "string" && Number.isInteger(s.status);
const stale = (s) => !(s.immutable === true && Date.now() - s.at < MAX_AGE_H * 3_600_000);
function loadSave(file, env) {
  const from = savePath(file, env);
  if (!from) return null;
  const saved = readSave(from);
  if (wellFormed(saved)) return recordPrev(env) && stale(saved) ? null : saved;
  log(env, "unreadable", 1);
  return null;
}
const keep = (file, env, r) => file && env.GH_REPLAY_MODE === "record" && (r.status === 0 || /\(HTTP (404|410|422)\)/.test(r.stderr));
function logRead(args, env, saved, r) {
  if (kindOf(args)) log(env, saved ? "replayed" : kindOf(args), saved ? 1 : r.pages);
  if (kindOf(args) === "rest" && !saved) appendFileSync(`${env.GH_REPLAY_DIR}.reads`, `${familyOf(args)} ${r.pages}\n`);
}
const finality = (args, saved, r) => (saved?.immutable ? { immutable: true, at: saved.at } : r.status === 0 && immutable(args, r.stdout.toString()) ? { immutable: true, at: Date.now() } : {});
function store(file, env, args, r, final) {
  if (!keep(file, env, r)) return;
  writeFileSync(`${file}.${process.pid}`, JSON.stringify({ args, out: r.stdout.toString("base64"), err: r.stderr.toString(), status: r.status, ...final }));
  renameSync(`${file}.${process.pid}`, file);
}
function shim(args, env) {
  const file = saveFile(args, env);
  const saved = loadSave(file, env);
  const r = ran(saved, args, env);
  if (r.error) return process.stderr.write(`gh-replay: ${r.error.message}\n`), 127;
  process.stdout.write(r.stdout), process.stderr.write(r.stderr);
  logRead(args, env, saved, r);
  store(file, env, args, r, finality(args, saved, r));
  return r.status ?? 1;
}
/** The GitHub requests notice: live REST and GraphQL calls, and reads replayed from main, summed from the log `rows`. */
export function summary(rows, mode) {
  const sum = (k) => rows.filter((r) => r[0] === k).reduce((n, r) => n + Number(r[1]), 0);
  return `live ${sum("rest")} REST, ${sum("graphql")} GraphQL; ${sum("replayed")} replayed from main (${mode})`;
}
/** The run ids of the `limit` newest main-reads artifacts under MAX_AGE_H old, from one artifacts listing: this repo's own main, never a fork's branch named main; a push or the daily run (#55), passed or failed. */
export function saveRuns(artifacts, now = Date.now(), limit = 2) {
  const fresh = artifacts.filter((a) => !a.expired && a.workflow_run?.head_branch === "main" && a.workflow_run.head_repository_id === a.workflow_run.repository_id && now - Date.parse(a.created_at) < MAX_AGE_H * 3_600_000);
  return fresh.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, limit).map((a) => String(a.workflow_run.id));
}
/** The `n` most-read families from the `.reads` log's `rows` ([family, requests]), as "family requests, …". */
export function topReads(rows, n = 6) {
  const sum = new Map();
  for (const [family, k] of rows) sum.set(family, (sum.get(family) ?? 0) + Number(k));
  return [...sum].sort((a, b) => b[1] - a[1]).slice(0, n).map(([family, k]) => `${family} ${k}`).join(", ");
}
/** Download main's newest save into `dir`; a failed run's save has reads but no scored run, so the next one tops it up. Return the run ids and the REST requests spent. */
function fetchSave(real, dir, env) {
  let artifacts = [];
  try { artifacts = JSON.parse(spawnSync(real, ["api", `repos/${env.GITHUB_REPOSITORY}/actions/artifacts?name=main-reads&per_page=10`]).stdout.toString()).artifacts ?? []; } catch { artifacts = []; }
  // A download lists the run's artifacts, then fetches one: 2 requests, or 1 when the run saved nothing (#61).
  let n = 1;
  const got = [];
  for (const run of saveRuns(artifacts)) {
    const into = got.length ? `${dir}-older` : dir;
    const ok = spawnSync(real, ["run", "download", run, "-n", "main-reads", "-D", into, "-R", env.GITHUB_REPOSITORY]).status === 0;
    n += ok ? 2 : 1;
    if (!ok) continue;
    if (got.length) cpSync(into, dir, { recursive: true, force: false });
    got.push(run);
    if (existsSync(path.join(dir, "latest.json"))) break;
  }
  return [got.join(" + "), n];
}
const modeOf = (env, pr) => (pr ? "replay" : env.GITHUB_EVENT_NAME === "push" && env.GITHUB_REF === "refs/heads/main" ? "record" : "count");
const liveTokens = (env, pr) => [env.GITHUB_SHA, env.GITHUB_RUN_ID, pr?.head.sha, ...(pr ? ["pulls/", "issues/", "pull/"].map((p) => p + pr.number) : [])].filter(Boolean).join(",");
function setup(env) {
  const dir = path.join(env.RUNNER_TEMP, "gh-replay");
  const real = spawnSync("sh", ["-c", "command -v gh"]).stdout.toString().trim();
  const pr = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")).pull_request;
  const mode = modeOf(env, pr);
  mkdirSync(path.join(dir, "r"), { recursive: true }), mkdirSync(`${dir}-bin`), writeShim(`${dir}-bin`);
  const prev = mode === "record" ? `${dir}-prev` : "";
  const [id, n] = pr || prev ? fetchSave(real, prev || dir, env) : ["", 0];
  if (pr || prev) log({ GH_REPLAY_DIR: dir }, "rest", n);
  appendFileSync(env.GITHUB_ENV, `GH_REPLAY_REAL=${real}\nGH_REPLAY_DIR=${dir}\nGH_REPLAY_MODE=${mode}\nGH_REPLAY_LIVE=${liveTokens(env, pr)}\n${prev && id ? `GH_REPLAY_PREV=${prev}\n` : ""}`);
  appendFileSync(env.GITHUB_PATH, `${dir}-bin\n`);
  appendFileSync(env.GITHUB_OUTPUT, `latest=${existsSync(path.join(dir, "latest.json"))}\n`);
  console.log(`gh-replay: ${mode}; main save under ${MAX_AGE_H} h old: ${id ? `run ${id}` : "none"}`);
}
function report(env) {
  const file = `${env.GH_REPLAY_DIR}.log`;
  const rows = existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => l.split(" ")) : [];
  if (env.GH_REPLAY_MODE === "record" && env.GH_REPLAY_JOB_STATUS === "success" && existsSync("data/quality/latest.json")) copyFileSync("data/quality/latest.json", path.join(env.GH_REPLAY_DIR, "latest.json"));
  console.log(`::notice title=GitHub requests::${summary(rows, env.GH_REPLAY_MODE)}`);
  const reads = `${env.GH_REPLAY_DIR}.reads`;
  if (existsSync(reads)) console.log(`::notice title=GitHub requests by read::${topReads(readFileSync(reads, "utf8").trim().split("\n").map((l) => l.split(" ")))}`);
  const bad = rows.filter((r) => r[0] === "unreadable").length;
  if (bad) console.log(`::warning title=GitHub requests::${bad} saved reads from main were unreadable, so each ran live`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  process.exitCode = cmd === "shim" ? shim(rest, process.env) : (cmd === "setup" ? setup : report)(process.env);
}
