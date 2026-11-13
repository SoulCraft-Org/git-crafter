// gh for pages.yml (#38): a push to main saves each public read; a pull request replays that save (data read as JSON by
// hashed name, never run); report prints the live requests ci.pr_run_requests sums. Anyone signed in can download a public
// repo's artifact, so a REST read is saved only on a PUBLIC family (each 200 to a tokenless curl, 2026-11-13), never DENY.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const [MAX_AGE_H, ISO] = [24, /\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?)?/g];
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
function loadSave(file, env) {
  if (!file || env.GH_REPLAY_MODE !== "replay" || !existsSync(file)) return null;
  let saved = null;
  try { saved = JSON.parse(readFileSync(file, "utf8")); } catch { saved = null; }
  if (typeof saved?.out === "string" && typeof saved.err === "string" && Number.isInteger(saved.status)) return saved;
  log(env, "unreadable", 1);
  return null;
}
const keep = (file, env, r) => file && env.GH_REPLAY_MODE === "record" && (r.status === 0 || /\(HTTP (404|410|422)\)/.test(r.stderr));
function shim(args, env) {
  const file = saveFile(args, env);
  const saved = loadSave(file, env);
  const r = ran(saved, args, env);
  if (r.error) return process.stderr.write(`gh-replay: ${r.error.message}\n`), 127;
  process.stdout.write(r.stdout), process.stderr.write(r.stderr);
  if (kindOf(args)) log(env, saved ? "replayed" : kindOf(args), saved ? 1 : r.pages);
  if (keep(file, env, r)) writeFileSync(`${file}.${process.pid}`, JSON.stringify({ args, out: r.stdout.toString("base64"), err: r.stderr.toString(), status: r.status })), renameSync(`${file}.${process.pid}`, file);
  return r.status ?? 1;
}
/** The GitHub requests notice: live REST and GraphQL calls, and reads replayed from main, summed from the log `rows`. */
export function summary(rows, mode) {
  const sum = (k) => rows.filter((r) => r[0] === k).reduce((n, r) => n + Number(r[1]), 0);
  return `live ${sum("rest")} REST, ${sum("graphql")} GraphQL; ${sum("replayed")} replayed from main (${mode})`;
}
/** Download main's save into `dir` from the newest run that has one; return its run id and the REST requests spent. */
function fetchSave(real, dir, env) {
  // The two newest successful main runs under 24 h old that record a save: a push, or the daily schedule (#55). One request.
  const jq = `limit(2; .workflow_runs[] | select((.event == "push" or .event == "schedule") and .head_repository.full_name == "${env.GITHUB_REPOSITORY}") | select(now - (.updated_at | fromdateiso8601) < ${MAX_AGE_H * 3600}) | .id)`;
  const ids = spawnSync(real, ["api", `repos/${env.GITHUB_REPOSITORY}/actions/workflows/${path.basename(env.GITHUB_WORKFLOW_REF.split("@")[0])}/runs?branch=main&status=success&per_page=10`, "--jq", jq]).stdout.toString().split("\n").filter(Boolean);
  // A download lists the run's artifacts, then fetches one: 2 requests, or 1 when the run saved nothing, so the fallback adds 1 (#61).
  let n = 1;
  for (const run of ids) {
    const ok = spawnSync(real, ["run", "download", run, "-n", "main-reads", "-D", dir, "-R", env.GITHUB_REPOSITORY]).status === 0;
    n += ok ? 2 : 1;
    if (ok) return [run, n];
  }
  return ["", n];
}
function setup(env) {
  const dir = path.join(env.RUNNER_TEMP, "gh-replay");
  const real = spawnSync("sh", ["-c", "command -v gh"]).stdout.toString().trim();
  const pr = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")).pull_request;
  const mode = pr ? "replay" : env.GITHUB_EVENT_NAME === "push" && env.GITHUB_REF === "refs/heads/main" ? "record" : "count";
  mkdirSync(path.join(dir, "r"), { recursive: true }), mkdirSync(`${dir}-bin`), writeShim(`${dir}-bin`);
  const [id, n] = pr ? fetchSave(real, dir, env) : ["", 0];
  if (pr) log({ GH_REPLAY_DIR: dir }, "rest", n);
  const live = [env.GITHUB_SHA, env.GITHUB_RUN_ID, pr?.head.sha, ...(pr ? ["pulls/", "issues/", "pull/"].map((p) => p + pr.number) : [])];
  appendFileSync(env.GITHUB_ENV, `GH_REPLAY_REAL=${real}\nGH_REPLAY_DIR=${dir}\nGH_REPLAY_MODE=${mode}\nGH_REPLAY_LIVE=${live.filter(Boolean).join(",")}\n`);
  appendFileSync(env.GITHUB_PATH, `${dir}-bin\n`);
  appendFileSync(env.GITHUB_OUTPUT, `latest=${existsSync(path.join(dir, "latest.json"))}\n`);
  console.log(`gh-replay: ${mode}; main save under ${MAX_AGE_H} h old: ${id ? `run ${id}` : "none"}`);
}
function report(env) {
  const file = `${env.GH_REPLAY_DIR}.log`;
  const rows = existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => l.split(" ")) : [];
  if (env.GH_REPLAY_MODE === "record" && existsSync("data/quality/latest.json")) copyFileSync("data/quality/latest.json", path.join(env.GH_REPLAY_DIR, "latest.json"));
  console.log(`::notice title=GitHub requests::${summary(rows, env.GH_REPLAY_MODE)}`);
  const bad = rows.filter((r) => r[0] === "unreadable").length;
  if (bad) console.log(`::warning title=GitHub requests::${bad} saved reads from main were unreadable, so each ran live`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  process.exitCode = cmd === "shim" ? shim(rest, process.env) : (cmd === "setup" ? setup : report)(process.env);
}
