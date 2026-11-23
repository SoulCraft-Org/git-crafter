// Merges one reviewed pull request: reads its base, its head and the latest run of every check, posts the
// verdict, then merges.
//
//   node tools/merge_pr.mjs --repo owner/name --pr N --sha <40-hex head the review passed> [--base main] [--wait 60] [--check]
//
// Run it after the review at that head passed. It refuses a base other than --base (a stacked pull request
// merged into its parent branch on 2026-11-23), a head that is not --sha, a draft, a conflict, any check whose
// latest run failed, and no checks at all. Judging each check by its latest run, an older cancelled run beside a
// newer one is no failure. Pending checks exit 3 (`gh pr checks N --watch --interval 60`, then run it again);
// mergeable UNKNOWN, which reads so for seconds after another merge, is re-read for up to --wait seconds, then
// exits 3. --check reads and judges, posts and merges nothing. Merges with --squash and --match-head-commit
// <sha>, never --auto or --admin. Exit 0 merged (or ready under --check), 1 refused, 2 usage, 3 not yet.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ghRunner } from "./apply_setup.mjs";

const USAGE = "usage: node tools/merge_pr.mjs --repo owner/name --pr N --sha <40 hex> [--base main] [--wait seconds] [--check]";
const PASS = new Set(["success", "neutral", "skipped"]);
const STATUS = { success: "pass", pending: "pending" };
const STEP = 5;

/** The checks of one head, each judged pass, pending or fail by its latest run (the highest id per app and name). */
export function judge(runs, statuses) {
  const latest = new Map();
  for (const r of runs) if (!(latest.get(`${r.app?.id}/${r.name}`)?.id > r.id)) latest.set(`${r.app?.id}/${r.name}`, r);
  const state = (r) => (r.status !== "completed" ? "pending" : PASS.has(r.conclusion) ? "pass" : "fail");
  return [...[...latest.values()].map((r) => ({ name: r.name, state: state(r) })), ...statuses.map((s) => ({ name: s.context, state: STATUS[s.state] ?? "fail" }))];
}

/** What to do with the pull request: { act: "merge" | "refuse" | "wait", why }; a wait names what it waits on. */
export function decide(pull, checks, { sha, base }) {
  const named = (state) => checks.filter((c) => c.state === state).map((c) => c.name).join(", ");
  if (pull.draft || pull.state !== "open") return { act: "refuse", why: pull.draft ? "is a draft" : `is ${pull.merged ? "merged" : pull.state}` };
  if (pull.base.ref !== base) return { act: "refuse", why: `base is ${pull.base.ref}, not ${base}: a stacked pull request merges through the stack` };
  if (pull.head.sha !== sha) return { act: "refuse", why: `head moved to ${pull.head.sha.slice(0, 7)}; the review passed ${sha.slice(0, 7)}` };
  if (!checks.length) return { act: "refuse", why: "no checks read" };
  if (named("fail")) return { act: "refuse", why: `latest run failed: ${named("fail")}` };
  if (named("pending")) return { act: "wait", on: "checks", why: `pending: ${named("pending")}` };
  if (pull.mergeable === false) return { act: "refuse", why: `conflicts with ${base}` };
  return pull.mergeable === null ? { act: "wait", on: "mergeable", why: "mergeable is UNKNOWN" } : { act: "merge", why: `${checks.length} checks pass at ${sha.slice(0, 7)}` };
}

// The command line as options, or { problem }.
function parseArgs(argv) {
  const o = { base: "main", wait: 60, check: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--check") o.check = true;
    else if (["--repo", "--pr", "--sha", "--base", "--wait"].includes(argv[i]) && argv[i + 1]) o[argv[i].slice(2)] = argv[++i];
    else return { problem: `unknown or incomplete argument ${argv[i]}` };
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(o.repo ?? "")) return { problem: "--repo must be owner/name" };
  if (!/^[1-9]\d*$/.test(o.pr ?? "")) return { problem: "--pr must be a pull request number" };
  if (!/^[0-9a-f]{40}$/.test(o.sha ?? "")) return { problem: "--sha must be the full 40-hex head the review passed" };
  return /^\d+$/.test(String(o.wait)) ? { ...o, wait: Number(o.wait) } : { problem: "--wait must be seconds" };
}

// Reads the pull request and its checks at `sha` and returns decide's answer with the pull request, re-reading mergeable UNKNOWN for up to `wait` seconds.
async function assess({ read, repo, pr, sha, base, wait, sleep }) {
  const runs = read(`repos/${repo}/commits/${sha}/check-runs?per_page=100`);
  const status = read(`repos/${repo}/commits/${sha}/status?per_page=100`);
  if (runs.total_count > runs.check_runs.length || status.total_count > status.statuses.length) throw new Error("more checks than one page holds, so some are unread");
  const checks = judge(runs.check_runs, status.statuses);
  for (let waited = 0; ; waited += STEP) {
    const pull = read(`repos/${repo}/pulls/${pr}`);
    const d = decide(pull, checks, { sha, base });
    if (d.on !== "mergeable" || waited >= wait) return { ...d, pull };
    await sleep(STEP * 1000);
  }
}

// Posts `Review: MERGE at <sha>` on the pull request unless a comment already opens with that line; a verdict is never edited.
function verdict(run, { repo, pr, sha }) {
  const route = `repos/${repo}/issues/${pr}/comments`;
  if (!run(["api", route, "--paginate", "-q", '.[].body | split("\\n")[0]']).split("\n").includes(`Review: MERGE at ${sha}`)) run(["api", route, "-f", `body=Review: MERGE at ${sha}`]);
}

/** The command line. `run` is gh, `sleep` the wait between reads (both injectable for tests). Returns the exit code. */
export async function main(argv = process.argv.slice(2), { run = ghRunner(), sleep = (ms) => new Promise((done) => setTimeout(done, ms)), log = console.log, error = console.error } = {}) {
  const o = parseArgs(argv);
  if (o.problem) {
    error(`${o.problem}\n${USAGE}`);
    return 2;
  }
  const read = (route) => JSON.parse(run(["api", route]));
  try {
    const d = await assess({ read, ...o, sleep });
    log(`${d.act} #${o.pr}: ${d.why}`);
    if (d.act !== "merge") return d.act === "wait" ? 3 : 1;
    if (o.check) return 0;
    verdict(run, o);
    run(["pr", "merge", o.pr, "--repo", o.repo, "--squash", "--match-head-commit", o.sha]);
    log(`merged #${o.pr} at ${o.sha}`);
    return 0;
  } catch (err) {
    error(`merge_pr: ${err.message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
