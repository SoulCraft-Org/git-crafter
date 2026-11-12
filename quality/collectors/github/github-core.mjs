// Shared pieces of the GitHub collector: its errors, the gh client, the unit constants and the result helpers the metric modules build on.
import { execFile } from "node:child_process";

export const TARGETS_FILE = "targets/github.json";

export const LOCAL_REFRESH = "refreshed by a --local collect run";

export const NEEDS = {
  "github-admin": `needs an admin token; ${LOCAL_REFRESH}`,
  // A workflow may grant this one itself: permissions: vulnerability-alerts: read (GitHub docs, Workflow syntax, read 2026-11-10).
  "vulnerability-alerts": `needs vulnerability-alerts: read on the workflow's token; ${LOCAL_REFRESH}`,
  "project-scope": "needs the project scope: gh auth refresh -s project",
};

export const HOUR = 3_600_000;

export const DAY = 24 * HOUR;

/** owner/name: the caller's, else params.repo, else GITHUB_REPOSITORY; null when none is owner/name. */
export function repoOf(repo, params = {}, env = process.env) {
  const slug = repo || params.repo || env.GITHUB_REPOSITORY || "";
  return /^[\w.-]+\/[\w.-]+$/.test(slug) ? slug : null;
}

/** A setting that is missing or wrong; its message is the whole could_not_check reason. */
export class ConfigError extends Error {}

/** A registry request that failed; its message is the whole could_not_check reason. */
export class RegistryError extends Error {}

/** A gh client whose every call fails with `reason`, for a run with no repo to read. */
export function refusingGh(reason) {
  const refuse = async () => {
    throw new ConfigError(reason);
  };
  return { rest: refuse, restAll: refuse, graphql: refuse, text: refuse };
}

/** A failed `gh` call. status is the HTTP status, 0 when gh never reached GitHub. */
export class GhError extends Error {
  constructor(message, { status = 0, type } = {}) {
    super(message);
    this.status = status;
    this.type = type;
  }
}

// GitHub calls in flight at once from every gh client in this process, whichever collector made them. The
// collect runs collectors side by side, and ci, github and insights each read all their metrics at once, so
// without one shared cap their sum had no bound. GitHub allows 100 concurrent requests (docs.github.com,
// "Rate limits for the REST API", read 2026-11-11).
export const GH_AT_ONCE = 16;
let ghLive = 0;
const ghWaiting = [];

/** Runs fn once a slot is free. A finishing call hands its slot straight to the next waiter, so the cap holds. */
export async function gated(fn) {
  if (ghLive < GH_AT_ONCE) ghLive += 1;
  else await new Promise((r) => ghWaiting.push(r));
  try {
    return await fn();
  } finally {
    const next = ghWaiting.shift();
    if (next) next();
    else ghLive -= 1;
  }
}

/** Runs `gh api` and parses its JSON; every failure becomes a GhError. `token`, when given, is GH_TOKEN for this client only. */
export function ghClient(token) {
  const env = { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1", ...(token ? { GH_TOKEN: token } : {}) };
  const run = (args) =>
    gated(() => new Promise((resolve, reject) => {
      execFile("gh", ["api", ...args], { env, maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
        let body;
        try {
          body = JSON.parse(stdout);
        } catch {
          body = undefined;
        }
        if (!err && body !== undefined) return resolve(body);
        if (err?.code === "ENOENT") return reject(new GhError("gh is not installed; install the GitHub CLI and run gh auth login"));
        const status = Number(/\(HTTP (\d{3})\)/.exec(stderr)?.[1] ?? 0);
        const first = body?.errors?.[0];
        const message = body?.message ?? first?.message ?? (stderr.trim() || err?.message || "gh api returned no JSON");
        reject(new GhError(message, { status, type: first?.type }));
      });
    }));
  return {
    rest: (route) => run([route]),
    restAll: async (route) => (await run(["--paginate", "--slurp", route])).flat(),
    graphql: async (query, variables = {}) => {
      const args = ["graphql", "-f", `query=${query}`];
      for (const [k, v] of Object.entries(variables)) {
        if (v == null) continue;
        args.push(typeof v === "string" ? "-f" : "-F", `${k}=${v}`);
      }
      const body = await run(args);
      if (body.errors?.length) throw new GhError(body.errors[0].message, { type: body.errors[0].type });
      return body.data;
    },
  };
}

// A CI run's admin reads (#837): a gh client on ADMIN_READ_TOKEN, a fine-grained read-only token the
// workflow passes through actions/pages' admin-read-token input, or null when it is unset. The value
// goes into gh's environment only, never onto a command line or into a reason.
export function adminGh(env = process.env) {
  const token = String(env.ADMIN_READ_TOKEN ?? "").trim();
  return token ? ghClient(token) : null;
}

// The client one metric reads with. A CI run's github-admin metric reads with `admin`, or is
// { skip } with its reason when there is none. Every other metric reads with `gh`.
export function clientFor({ mode, needs, gh, admin }) {
  if (mode !== "ci" || needs !== "github-admin") return { gh };
  return admin ? { gh: admin } : { skip: NEEDS["github-admin"] };
}

// Rounds to one decimal.
export const round1 = (x) => Math.round(x * 10) / 10;

// part as a percent of whole, to one decimal.
export const pct = (part, whole) => round1((100 * part) / whole);

// Hours from one ISO time to another, never below 0.
export const hours = (from, to) => Math.max(0, (Date.parse(to) - Date.parse(from)) / HOUR);

// A could_not_check value with its reason.
export const skip = (reason) => ({ could_not_check: reason });

// A measured value, with detail rows when given.
export const measured = (value, detail) => (detail ? { value, detail } : { value });

// Breakdown items that count something other than the headline carry their own
// unit, which overrides the metric's (detail[].unit in the collector contract).
// A flag is a plain 1 (present, on) or 0, so it never reads as "1 of 4".
export const count = (label, value) => ({ label, value, unit: "" });

// A 1 or 0 detail row for a setting that is on or off.
export const flag = (label, isOn) => count(label, isOn ? 1 : 0);

/** Linear-interpolated percentile (the numpy default), q in 0..1. */
export function percentile(values, q) {
  const s = [...values].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo);
}

/** Counts per key, in `order` first (zeros kept), then any other key seen. */
export function tally(keys, order = []) {
  const counts = new Map(order.map((k) => [k, 0]));
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  return [...counts].map(([label, value]) => ({ label, value }));
}

/** Follows a GraphQL connection until it ends or `limit` nodes are read. */
export async function connection(gh, query, variables, pick, limit = Infinity) {
  const nodes = [];
  let cursor = null;
  do {
    const conn = pick(await gh.graphql(query, { ...variables, cursor }));
    nodes.push(...conn.nodes);
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor && nodes.length < limit);
  return nodes.slice(0, limit);
}
