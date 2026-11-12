// Insights collector for the Quality, Speed and Consumption page. It fills the
// Insights tab, named after GitHub's own: one metric per Insights view that has
// a documented practice, an API and a number that moves. Community: GitHub's
// health percentage. Network and People: insights-access.mjs. Contributors and
// Dependency graph have none: linked commits and parsed manifests read at
// their goal on every run. Actions usage is read by the CI collector
// (ci-insights.mjs), which already loads those runs; job wait sits on the
// Actions tab.
// Pulse, Commits and Code frequency are scored on the Issues, Pull requests
// and Code tabs. Traffic and Forks have no metric: clones count workflow
// checkouts, and no documented practice sets a goal for either.
//
// No metric uses a calendar window: each is a state read now or the last N
// events. Every read is `gh api`, so the same code runs in CI on GITHUB_TOKEN
// and in a session. collect() never throws: a read that fails becomes
// could_not_check with its reason, never a 0 (the collector contract).
//
// Calls per read: 1 community profile, 1 GraphQL call per 100 branches and,
// in a local run or a CI run given ADMIN_READ_TOKEN, the
// collaborators and 1 commit lookup for each person who can push.

import { readFileSync } from "node:fs";

import { adminGh, clientFor, flag, ghClient, measured, repoOf, skip } from "../github/github-core.mjs";
import { reasonFor } from "../github/github-helpers.mjs";
import { ACCESS_METRICS } from "./insights-access.mjs";

export const area = "insights";
// Reads the GitHub API: collect.mjs skips it under the API reserve (ci.json params.api_reserve).
export const githubApi = true;

const TARGETS_FILE = "targets/insights.json";

// This file's own targets and params: the defaults when the engine passes none.
const OWN_TARGETS = JSON.parse(readFileSync(new URL("../../targets/insights.json", import.meta.url), "utf8"));
const OWN_PARAMS = Object.assign({}, ...OWN_TARGETS.map((t) => t.params ?? {}));

// The profile's file keys that follow the checklist. issue_template is left
// out: it stays null for issue forms, which the percentage does count.
const HEALTH_FILES = [
  ["readme", "README"],
  ["license", "License"],
  ["contributing", "Contributing guide"],
  ["code_of_conduct", "Code of conduct"],
  ["pull_request_template", "Pull request template"],
];

/** GitHub's community health percentage, with a flag per health file it found. */
export function communityHealth(profile) {
  if (typeof profile?.health_percentage !== "number") return skip("GitHub answered without a health percentage");
  const files = HEALTH_FILES.map(([key, label]) => flag(label, Boolean(profile.files?.[key])));
  return measured(profile.health_percentage, [flag("Description", Boolean(profile.description)), ...files]);
}

const METRICS = {
  "insights.community_health_pct": {
    source: "state: gh api repos/{repo}/community/profile, GitHub's health percentage and the files it found",
    run: async ({ gh, repo }) => communityHealth(await gh.rest(`repos/${repo}/community/profile`)),
  },
  ...ACCESS_METRICS,
};

export const METRIC_IDS = Object.keys(METRICS);

/** One metric's entry: its value with the time read, or the reason it could not be read. */
async function readMetric(id, metric, ctx) {
  const source = metric.source.replaceAll("{repo}", ctx.repo ?? "owner/name");
  const needs = ctx.targets.find((t) => t.id === id)?.needs;
  const client = clientFor({ mode: ctx.mode, needs, gh: ctx.gh, admin: ctx.admin });
  if (client.skip) return [id, { could_not_check: client.skip, source }];
  try {
    const result = await metric.run({ ...ctx, gh: client.gh });
    if (result.could_not_check) return [id, { could_not_check: result.could_not_check, source }];
    return [id, { ...result, source, read_at: new Date().toISOString() }];
  } catch (err) {
    return [id, { could_not_check: reasonFor(err, needs, ctx.mode), source }];
  }
}

/**
 * Reads the Insights metrics among `targets`. `params` and `targets` come from
 * the engine; this file's own are the defaults. `gh`, `admin`, `repo`
 * and `now` are injectable for tests; the defaults are the real gh CLI,
 * gh on ADMIN_READ_TOKEN for a CI run's admin reads (null when unset),
 * params.repo or GITHUB_REPOSITORY, and the clock, which only the People
 * metric reads, for the age of a latest commit.
 */
export async function collect({ mode = "local", params = OWN_PARAMS, targets = OWN_TARGETS, gh = ghClient(), admin = adminGh(), repo, now = Date.now() } = {}) {
  // Only the metrics the engine keeps: a dropped one is never read.
  const active = Object.entries(METRICS).filter(([id]) => targets.some((t) => t.id === id));
  const slug = repoOf(repo, params);
  if (!slug) {
    const reason = `no repo to read: params.repo in ${TARGETS_FILE} is not owner/name, and GITHUB_REPOSITORY is unset`;
    return Object.fromEntries(active.map(([id, metric]) => [id, { could_not_check: reason, source: metric.source.replaceAll("{repo}", "owner/name") }]));
  }
  const ctx = { mode, gh, admin, repo: slug, params: { ...OWN_PARAMS, ...params }, targets, now: Number(now) };
  return Object.fromEntries(await Promise.all(active.map(([id, metric]) => readMetric(id, metric, ctx))));
}
