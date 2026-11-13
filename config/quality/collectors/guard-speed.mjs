// Git Crafter's own Speed metric on the Code tab: how long the bash guard takes
// to judge one command on a cloud runner. The guard runs before every Bash
// call in every session, so it is this repo's hot path. The metric is this
// repo's own, not the template's, because an adopting repo ships no guard.
// Its time on the machine that runs the sessions, guards.call_ms, left for the
// Claudius pack, which reads local files (v7.0.0).
//
// guards.runner_call_ms: tools/tests/guard_speed.py times corpus cases with
// bash_guard.py --check in verify.yml's short job, right after the
// self-test, and prints one line. This collector reads that line from the
// newest successful run on the default branch, as code-test.mjs reads a
// suite's lcov. Those GitHub readers load packages (yaml, typescript), so they
// are imported only when this metric is read, and a missing package reads as
// could_not_check. Nothing here throws.
import { firstLine, measured, unknown } from "../../../quality/collectors/lib/index.mjs";

export const area = "guard-speed";
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
// guards.runner_call_ms from the newest successful run's job log.
export async function collect({ params = {}, allParams = {}, gh = null }) {
  return runnerReading({ params, allParams, gh });
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
