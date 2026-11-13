// gh for pages.yml (#38): setup puts a gh shim first on PATH; a push to main records each read, a pull request replays
// main's save (data read as JSON by hashed name, never run), and report prints the live requests ci.pr_run_requests sums.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const MAX_AGE_H = 24;
const ISO = /\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?)?/g;
/** Whether gh `args` only reads: gh api with no write method, input or field (GraphQL takes fields, never a mutation), or pr/issue list. */
export function readOnly(args) {
  if (args[0] === "pr" || args[0] === "issue") return args[1] === "list";
  const field = args[1] === "graphql" ? /^query=\s*mutation\b/ : /^(-f|-F|--field|--raw-field|query=\s*mutation\b)/;
  return args[0] === "api" && args.every((a, i) => a !== "--input" && !field.test(a) && !/^--method=(?!get$)/i.test(a) && !(/^(-X|--method)$/.test(a) && !/^get$/i.test(args[i + 1] ?? "")));
}
/** The save's name for `args`: a sha256 with each date as days and each time as hours from `now`, so a window read off the clock matches a day later. */
export function keyOf(args, now = Date.now()) {
  const day = now - (now % 86_400_000);
  const rel = args.map((a) => a.replace(ISO, (m) => (m.includes("T") ? `@${Math.round((Date.parse(m) - now) / 3_600_000)}h` : `@${(Date.parse(m) - day) / 86_400_000}d`)));
  return createHash("sha256").update(JSON.stringify(rel)).digest("hex");
}
/** The shim gh, written into `dir`. */
export const writeShim = (dir) => writeFileSync(path.join(dir, "gh"), `#!/bin/sh\nexec node "${fileURLToPath(import.meta.url)}" shim "$@"\n`, { mode: 0o755 });
const log = (env, kind, n) => appendFileSync(`${env.GH_REPLAY_DIR}.log`, `${kind} ${n}\n`);
const saveFile = (args, env) => readOnly(args) && env.GH_TOKEN !== (env.ADMIN_READ_TOKEN || null) && !(env.GH_REPLAY_LIVE ?? "").split(",").some((t) => t && args.some((a) => a.includes(t))) && path.join(env.GH_REPLAY_DIR, "r", `${keyOf(args)}.json`);
const ran = (saved, args, env) => (saved ? { stdout: Buffer.from(saved.out, "base64"), stderr: saved.err, status: saved.status } : spawnSync(env.GH_REPLAY_REAL, args, { stdio: ["inherit", "pipe", "pipe"], maxBuffer: 2 ** 31 }));
const kindOf = (args) => (args[1] === "rate_limit" ? null : args[0] === "api" && args[1] !== "graphql" ? "rest" : "graphql");
const pagesOf = (args, out) => { try { return (args.includes("--slurp") && JSON.parse(out).length) || 1; } catch { return 1; } };
const keep = (file, env, r) => file && env.GH_REPLAY_MODE === "record" && (r.status === 0 || /\(HTTP (404|410|422)\)/.test(r.stderr));
function shim(args, env) {
  const file = saveFile(args, env);
  const saved = file && env.GH_REPLAY_MODE === "replay" && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  const r = ran(saved, args, env);
  if (r.error) return process.stderr.write(`gh-replay: ${r.error.message}\n`), 127;
  process.stdout.write(r.stdout), process.stderr.write(r.stderr);
  if (kindOf(args)) log(env, saved ? "replayed" : kindOf(args), saved ? 1 : pagesOf(args, r.stdout));
  if (keep(file, env, r)) writeFileSync(`${file}.${process.pid}`, JSON.stringify({ args, out: r.stdout.toString("base64"), err: r.stderr.toString(), status: r.status })), renameSync(`${file}.${process.pid}`, file);
  return r.status ?? 1;
}
/** The job's notice line from its calls.log rows ([kind, count]). */
export function summary(rows, mode) {
  const sum = (k) => rows.filter((r) => r[0] === k).reduce((n, r) => n + Number(r[1]), 0);
  return `live ${sum("rest")} REST, ${sum("graphql")} GraphQL; ${sum("replayed")} replayed from main (${mode})`;
}
function setup(env) {
  const dir = path.join(env.RUNNER_TEMP, "gh-replay");
  const real = spawnSync("sh", ["-c", "command -v gh"]).stdout.toString().trim();
  const pr = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")).pull_request;
  const mode = pr ? "replay" : env.GITHUB_EVENT_NAME === "push" && env.GITHUB_REF === "refs/heads/main" ? "record" : "count";
  mkdirSync(path.join(dir, "r"), { recursive: true }), mkdirSync(`${dir}-bin`), writeShim(`${dir}-bin`);
  const jq = `.workflow_runs[] | select(.head_repository.full_name == "${env.GITHUB_REPOSITORY}" and now - (.updated_at | fromdateiso8601) < ${MAX_AGE_H * 3600}) | .id`;
  const id = pr ? spawnSync(real, ["api", `repos/${env.GITHUB_REPOSITORY}/actions/workflows/${path.basename(env.GITHUB_WORKFLOW_REF.split("@")[0])}/runs?branch=main&event=push&status=success&per_page=1`, "--jq", jq]).stdout.toString().trim() : "";
  const got = id && spawnSync(real, ["run", "download", id, "-n", "main-reads", "-D", dir, "-R", env.GITHUB_REPOSITORY]).status === 0;
  if (pr) log({ GH_REPLAY_DIR: dir }, "rest", id ? 3 : 1);
  const live = [env.GITHUB_SHA, env.GITHUB_RUN_ID, pr?.head.sha, ...(pr ? ["pulls/", "issues/", "pull/"].map((p) => p + pr.number) : [])];
  appendFileSync(env.GITHUB_ENV, `GH_REPLAY_REAL=${real}\nGH_REPLAY_DIR=${dir}\nGH_REPLAY_MODE=${mode}\nGH_REPLAY_LIVE=${live.filter(Boolean).join(",")}\n`);
  appendFileSync(env.GITHUB_PATH, `${dir}-bin\n`);
  appendFileSync(env.GITHUB_OUTPUT, `latest=${existsSync(path.join(dir, "latest.json"))}\n`);
  console.log(`gh-replay: ${mode}; main save under ${MAX_AGE_H} h old: ${got ? `run ${id}` : "none"}`);
}
// A main run adds its scored run to the save.
function report(env) {
  const file = `${env.GH_REPLAY_DIR}.log`;
  const rows = existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => l.split(" ")) : [];
  if (env.GH_REPLAY_MODE === "record" && existsSync("data/quality/latest.json")) copyFileSync("data/quality/latest.json", path.join(env.GH_REPLAY_DIR, "latest.json"));
  console.log(`::notice title=GitHub requests::${summary(rows, env.GH_REPLAY_MODE)}`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  process.exitCode = cmd === "shim" ? shim(rest, process.env) : (cmd === "setup" ? setup : report)(process.env);
}
