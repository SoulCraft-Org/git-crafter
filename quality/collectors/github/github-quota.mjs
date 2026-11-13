// GitHub's hourly API quota for the token a run holds: the account's login on
// a maintainer's machine, the workflow token in Actions. gh api rate_limit
// counts against no limit (GitHub docs, "Rate limits for the REST API", read
// 2026-11-11). The Actions tab's ci.api_headroom and collect.mjs --local's
// guard both read it here.

// The two buckets every collector spends, by rate_limit's resource name.
export const BUCKETS = [
  { resource: "core", label: "REST requests" },
  { resource: "graphql", label: "GraphQL points" },
];

export const QUOTA_SOURCE = "gh api rate_limit (counts against no limit)";

/** rate_limit's resources, or a thrown GhError. */
export async function readQuota(gh) {
  const body = await gh.rest("rate_limit");
  if (!body?.resources) throw new Error("rate_limit returned no resources");
  return body.resources;
}

// One decimal of a percent.
const pct1 = (part, whole) => Math.round((1000 * part) / whole) / 10;

/**
 * The share of each bucket still unused, as a metric: the value is the lower
 * of the two, so the bucket nearer empty sets it. null when a bucket is missing.
 */
export function headroom(resources) {
  const detail = [];
  for (const b of BUCKETS) {
    const r = resources?.[b.resource];
    if (typeof r?.limit !== "number" || typeof r?.remaining !== "number" || r.limit <= 0) return null;
    detail.push({ label: `${b.label} left of ${r.limit}`, value: pct1(r.remaining, r.limit), remaining: r.remaining, reset: r.reset });
  }
  return { value: Math.min(...detail.map((d) => d.value)), detail };
}

/** What each bucket's remaining fell by between two readings, never below 0 (a reset in between reads as 0). */
export function spent(before, after) {
  return Object.fromEntries(BUCKETS.map(({ resource }) => [resource, Math.max(0, (before?.[resource]?.remaining ?? 0) - (after?.[resource]?.remaining ?? 0))]));
}

/**
 * Why a run needing `need` ({ core, graphql }) would not fit in `resources`,
 * or null when it fits. The message names each short bucket and its reset.
 */
export function shortfall(resources, need) {
  const short = [];
  for (const b of BUCKETS) {
    const r = resources?.[b.resource];
    const want = need?.[b.resource] ?? 0;
    if (typeof r?.remaining !== "number") short.push(`${b.label}: rate_limit has no ${b.resource} bucket`);
    else if (r.remaining < want) short.push(`${b.label}: ${r.remaining} left, a full run needs about ${want}, resets ${new Date(r.reset * 1000).toISOString().slice(11, 16)} UTC`);
  }
  return short.length ? short.join("; ") : null;
}
