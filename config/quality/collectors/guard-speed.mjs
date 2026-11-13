// Git Crafter's own Speed metric on the Code tab: how long the bash guard takes
// to judge one command. The guard runs before every Bash call in every
// session, so it is this repo's hot path. The metric is this repo's own, not
// the template's, because an adopting repo ships no guard.
//
// The guard reads the hook call on stdin and only parses it: the command is
// never run (rules/gates.md). Nothing here throws; a guard that cannot be
// timed is could_not_check with the reason, never 0.
//
// It is timed only where it runs: on the machine that runs the sessions, in a
// --local collect, as the Blockers and Tokens collectors read their data. A CI
// runner is not that machine: it is slower and runs the other collectors at
// the same time, so a reading there times the runner (346 ms on 2026-11-10
// against 57 ms on the session's machine the same day).
//
// guards.runner_call_ms is the cloud-class reading: tools/tests/guard_speed.py
// times corpus cases with bash_guard.py --check in verify.yml's short job,
// right after the self-test, and prints one line. This collector reads that
// line from the newest successful run on the default branch, as code-test.mjs
// reads a suite's lcov, so no runner is timed twice. Those GitHub readers load
// packages (yaml, typescript), so they are imported only when this metric is
// read, and a missing package reads as could_not_check. The helpers here come
// through collectors/lib/, which loads yaml with the scorer; the Pages action
// installs Git Crafter's packages in every mode, so they are there (#650).
import { firstLine, measured, runCommand, unknown } from "../../../quality/collectors/lib/index.mjs";

export const area = "guard-speed";
const ID = "guards.call_ms";
const RUNNER_ID = "guards.runner_call_ms";
// The line guard_speed.py prints; GitHub prefixes each log line with a timestamp.
const SPEED_LINE = /== guard speed: median (\d+(?:\.\d+)?) ms, p95 (\d+(?:\.\d+)?) ms, (\d+) calls/;

// { median, p95, calls } from the last guard speed line of a job log, or null.
export function guardSpeedFromLog(log) {
  const hits = [...String(log).matchAll(new RegExp(SPEED_LINE, "g"))];
  if (!hits.length) return null;
  const [, median, p95, calls] = hits.at(-1);
  return { median: Number(median), p95: Number(p95), calls: Number(calls) };
}
const CI_REASON = "the guard runs on the machine that runs the sessions; timed by a --local collect there";
// One harmless hook call, as Claude Code sends it before a Bash call.
const CALL = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } });

// The median wall time of params.runs runs of the guard on one harmless
// command, in this run. The median leaves out a cold first start.
export async function collect({ root, mode, params = {}, allParams = {}, run = runCommand, gh = null }) {
  return { ...(await sessionMachine({ root, mode, params, run })), ...(await runnerReading({ params, allParams, gh })) };
}

// guards.runner_call_ms: the median from the guard speed line of the newest
// successful params.workflow run on the default branch, its p95 beside it.
async function runnerReading({ params, allParams, gh }) {
  const suite = { workflow: params.workflow || "verify.yml", job: params.job || "short" };
  const source = `latest: median of the guard speed line tools/tests/guard_speed.py prints in ${suite.workflow} job ${suite.job}, newest successful run on the default branch`;
  const repo = allParams["github.json"]?.repo || process.env.GITHUB_REPOSITORY || "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { [RUNNER_ID]: unknown("no repo: set params.repo in quality/targets/github.json", source) };
  const read = await readRun(gh, repo, allParams["ci.json"]?.default_branch || "", suite).catch((err) => `could not read the run: ${firstLine(err.message)}`);
  if (typeof read === "string") return { [RUNNER_ID]: unknown(read, source) };
  const { run, got } = read;
  const row = (label, ms) => ({ label, value: ms, unit: "ms" });
  return { [RUNNER_ID]: measured(got.median, `${source}: run ${run.id} (${String(run.created_at).slice(0, 10)}), ${got.calls} calls`, [row("median", got.median), row("p95", got.p95)]) };
}

// { run, got } from the suite job's log in the newest successful run, or the
// reason there is none. The GitHub readers load packages, so they load here.
async function readRun(gh, repo, branch, suite) {
  const { newestJob } = await import("../../../quality/collectors/lib/readers.mjs");
  const client = gh ?? (await import("../../../quality/collectors/lib/readers.mjs")).ciClient();
  const found = await newestJob(client, repo, branch, suite);
  if (typeof found === "string") return found;
  const got = guardSpeedFromLog(await client.text(`repos/${repo}/actions/jobs/${found.job.id}/logs`));
  return got ? { run: found.run, got } : `the log of ${suite.workflow} run ${found.run.id} has no guard speed line`;
}

// guards.call_ms, timed here on the machine that runs the sessions.
async function sessionMachine({ root, mode, params, run }) {
  const guard = params.guard || "tools/bash_guard.py";
  const runs = Number(params.runs) > 0 ? Number(params.runs) : 10;
  const source = `latest: median wall time of ${runs} runs of python3 -I ${guard} judging one harmless command, on the machine that runs the sessions`;
  if (mode !== "local") return { [ID]: unknown(CI_REASON, source) };
  const times = [];
  for (let i = 0; i < runs; i++) {
    const r = await run("python3", ["-I", guard], { cwd: root, input: CALL, timeoutMs: 10_000 });
    if (r.missing) return { [ID]: unknown("python3 is not on PATH", source) };
    if (r.code !== 0) return { [ID]: unknown(`the guard exited ${r.code} on a harmless command (${firstLine(r.stderr)})`, source) };
    times.push(r.ms);
  }
  times.sort((a, b) => a - b);
  const median = (times[Math.floor((runs - 1) / 2)] + times[Math.ceil((runs - 1) / 2)]) / 2;
  const row = (label, ms) => ({ label, value: Math.round(ms), unit: "ms" });
  return { [ID]: measured(Math.round(median), source, [row("fastest run", times[0]), row("median", median), row("slowest run", times.at(-1))]) };
}
