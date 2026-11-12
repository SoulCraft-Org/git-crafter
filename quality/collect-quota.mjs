// collect.mjs's GitHub quota checks: log gh api rate_limit before and after
// every run, keep the API reserve, stop a full --local run that would not
// fit, and record what a full run spent in local.json for the next check.

import { readFileSync } from "node:fs";

import { ghClient } from "./collectors/github/github-core.mjs";
import { BUCKETS, readQuota, shortfall, spent } from "./collectors/github/github-quota.mjs";
import { redactText } from "./collectors/lib/redact.mjs";

// What a full --local run spends when local.json holds no reading of its own:
// the account's use in the hour of the 2026-11-10 org collect, 2,362 REST
// requests and 483 GraphQL points (systems.github.rest_used and graphql_used,
// data/org.json, read 18:23 UTC). An upper bound: every session shares it.
export const FULL_RUN_GUESS = { core: 2362, graphql: 483 };

// The could_not_check reason a GitHub collector's metrics carry when the run
// skipped it under the reserve (#679).
const RESERVE_REASON = "api reserve";

/** rate_limit's resources, or null, logged, when gh cannot read them. */
export async function readQuotaOrNull(gh) {
  try {
    return await readQuota(gh);
  } catch (err) {
    console.error(`quality: could not read gh api rate_limit (${redactText(err.message)}); collecting without the quota check`);
    return null;
  }
}

/**
 * The calls a run leaves unspent: ci.json's params.api_reserve; 0 or unset turns the reserve off.
 * It lives on the CI tab's targets file, so a repo that drops that tab or file has no reserve:
 * move it with the file, or set it in the repo's own ci.json.
 */
export function reserveFloor(params) {
  const floor = Number(params?.["ci.json"]?.api_reserve ?? 0);
  return Number.isFinite(floor) && floor > 0 ? floor : 0;
}

/**
 * Why the run skips its GitHub reads: each bucket with fewer calls left
 * than `floor`, as the could_not_check reason. null when every bucket is at
 * or over it, or rate_limit was unread (each collector then reports its own
 * failure).
 */
export function reserveShort(resources, floor) {
  if (!resources || !floor) return null;
  const low = BUCKETS.filter(({ resource }) => typeof resources[resource]?.remaining === "number" && resources[resource].remaining < floor);
  if (!low.length) return null;
  return `${RESERVE_REASON}: ${low.map(({ resource, label }) => `${resources[resource].remaining} ${label} left`).join(", ")}, under the floor of ${floor} (ci.json params.api_reserve), so the GitHub collectors did not run`;
}

/** The run's one quota line: each bucket's limit, used and left after the run, and what the run spent. */
export function quotaLine(before, after) {
  if (!before) return "GitHub API: rate_limit unread, calls spent unknown";
  const used = after ? spent(before, after) : null;
  const parts = BUCKETS.map(({ resource, label }) => {
    const r = after?.[resource] ?? before[resource];
    if (typeof r?.remaining !== "number") return `${label}: no ${resource} bucket`;
    return `${label} limit ${r.limit}, used ${r.used ?? r.limit - r.remaining}, left ${r.remaining}, spent ${used ? used[resource] : "unknown"}`;
  });
  return `GitHub API: ${parts.join("; ")}`;
}

/** What a full local run needs, and where that figure came from. */
export function fullRunNeed(prior) {
  const s = prior?.api_spend;
  if (Number.isFinite(s?.core) && Number.isFinite(s?.graphql)) return { need: { core: s.core, graphql: s.graphql }, from: `the last full local run's own spend, ${String(s.read_at ?? prior.generated_at).slice(0, 10)}` };
  return { need: FULL_RUN_GUESS, from: "the 2026-11-10 collect hour's use, no local run has recorded its own" };
}

/**
 * The quota check before a --local run: { before, stop }. before is
 * rate_limit's resources (null when unreadable: the run goes on, and each
 * collector reports its own failure); stop is the message when a full run
 * would not fit. A --only run is never stopped.
 */
export async function quotaGate({ gh, prior, only }) {
  const before = await readQuotaOrNull(gh);
  if (!before || only) return { before, stop: null };
  const { need, from } = fullRunNeed(prior);
  const short = shortfall(before, need);
  return { before, stop: short && `quality: a full --local collect would not fit in this hour's GitHub API quota, so nothing ran. ${short} (the need is ${from}). Wait for the reset, or run one collector alone: --local --only NAME.` };
}

// A JSON file, or null when it is missing or unreadable.
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Before any run: { before, local }. before is rate_limit's resources, or
 * null. local, for a --local run only, holds the prior local.json and the
 * gate; it exits 4 when the gate stops the run.
 */
export async function quotaStart(mode, out, only, gh = ghClient()) {
  if (mode !== "local") return { before: await readQuotaOrNull(gh), local: null };
  const prior = readJson(out);
  const gate = await quotaGate({ gh, prior, only });
  if (gate.stop) {
    console.error(gate.stop);
    process.exit(4);
  }
  return { before: gate.before, local: { prior, gate } };
}

/**
 * After a run: the metrics and collectors to write, and extra fields for the run (api_spend); a CI run (local null) passes through.
 * One collector alone keeps the rest of local.json and its spend; a full run
 * records what it spent, read from `after`, so the next check uses a
 * reading, not a guess.
 */
export function recordLocal(local, { metrics, ran, only, after = null }) {
  if (!local) return { metrics, ran, extra: {} };
  const { prior, gate } = local;
  if (only) return { metrics: { ...(prior?.metrics ?? {}), ...metrics }, ran: [...new Set([...(prior?.collectors ?? []), ...ran])], extra: prior?.api_spend ? { api_spend: prior.api_spend } : {} };
  if (!gate.before || !after) return { metrics, ran, extra: {} };
  const api_spend = { ...spent(gate.before, after), read_at: new Date().toISOString(), source: "gh api rate_limit before and after this run; other sessions' calls in between count too" };
  return { metrics, ran, extra: { api_spend } };
}
