// Shared pieces of the CI collector: the run samples it reads, runner prices, the stage order and the small helpers every module builds on.

export const TARGETS_FILE = "targets/ci.json";

/** Runs one list call reads per workflow, newest first. */
export const RUNS_PER_WORKFLOW = 100;

/** Runs each run metric reads per workflow. */
export const LAST_RUNS = 20;

/** Merged pull requests, newest first. */
export const LAST_PRS = 20;

/** Runs per workflow whose REST jobs give queue times (GraphQL has no job creation time). */
export const QUEUE_SAMPLE = 10;

export const LOG_SAMPLE = 12;

export const LAST = `last ${LAST_RUNS} runs per workflow`;

// GitHub's dynamic Code Quality workflow: a code product the Code tab owns, so no security scan (#62).
export const CODE_QUALITY = "CodeQL - Code Quality";

// List prices per minute of the standard GitHub-hosted runners, from
// docs.github.com "Actions runner pricing" (read 2026-11-03,
// https://docs.github.com/en/billing/reference/actions-runner-pricing):
// Linux 1-core x64 (ubuntu-slim) $0.002, Linux 2-core x64 $0.006, Linux
// 2-core arm64 $0.005, Windows 2-core x64 or arm64 $0.010, macOS 3-core or
// 4-core (M1 or Intel) $0.062. A larger or self-hosted runner's label
// matches none, so its price is unknown, never 0.
export const RUNNER_RATES = [
  [/^ubuntu-slim$/i, 0.002],
  [/^ubuntu-[\w.]+-arm$/i, 0.005],
  [/^ubuntu-(latest|\d+\.\d+)$/i, 0.006],
  [/^windows-(latest|\d+)(-arm)?$/i, 0.01],
  [/^macos-(latest|\d+)$/i, 0.062],
];

/** A job's list price per minute from its runs-on labels, or null when no label is a standard runner. */
export function runnerRate(labels) {
  for (const label of labels ?? []) {
    for (const [re, rate] of RUNNER_RATES) if (re.test(String(label))) return rate;
  }
  return null;
}

export const STAGE_ORDER = ["edit", "commit", "push", "ci", "review", "merge", "deploy"];

// GitHub answers a spent rate limit with HTTP 403, the same status as a
// missing scope, so the message decides which one it was.
export const RATE_LIMIT = /rate limit/i;

// Rounds to one decimal.
export const round1 = (x) => Math.round(x * 10) / 10;

// Rounds to three decimals.
export const round3 = (x) => Math.round(x * 1000) / 1000;

// part as a percent of whole, to one decimal.
export const pct = (part, whole) => round1((100 * part) / whole);

// A could_not_check value with its reason.
export const skip = (reason) => ({ could_not_check: reason });

// A measured value, with detail rows when given.
export const measured = (value, detail) => (detail ? { value, detail } : { value });

// An ISO time in epoch milliseconds.
export const ms = (iso) => Date.parse(iso);

// Sort order for runs: newest created_at first.
export const byNewest = (a, b) => ms(b.created_at) - ms(a.created_at);

// True for a finished run.
export const completed = (r) => r.status === "completed";

/** The run created last. */
export const newest = (runs) => runs.reduce((a, b) => (ms(b.created_at) > ms(a.created_at) ? b : a));

// An epoch time as "YYYY-MM-DD HH:MM UTC".
export const utc = (t) => `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;

// Items grouped in a Map by key(item), in first-seen order.
export function groupBy(items, key) {
  const groups = new Map();
  for (const item of items) {
    const k = key(item);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(item);
  }
  return groups;
}

// Maps items through async fn with at most limit calls at once, results in input order.
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
