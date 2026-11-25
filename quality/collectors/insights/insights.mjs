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

import { adminGh, clientFor, flag, GhError, ghClient, measured, repoOf, skip } from "../github/github-core.mjs";
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

// Where GitHub looks for each health file: the root, docs/ and .github/ (About community profiles, read 2026-11-25).
const HEALTH_DIRS = ["", "docs", ".github"];
const HEALTH_NAMES = {
  readme: /^readme([._-].+)?$/i,
  license: /^(licen[sc]e|copying|unlicense)([._-].+)?$/i,
  contributing: /^contributing([._-].+)?$/i,
  code_of_conduct: /^code[_-]of[_-]conduct([._-].+)?$/i,
  pull_request_template: /^pull_request_template([._-].+)?$/i,
};

/**
 * GitHub answers 404 for a fork's community profile (seen 2026-11-25 on a public fork whose parent answers).
 * The same six checks are then read from the fork's own tree, and the score is the share found: GitHub's own
 * weights are not published, so this is the checklist's share, not GitHub's percentage.
 */
export async function forkHealth(gh, repo, info) {
  const lists = await Promise.all(HEALTH_DIRS.map((dir) => gh.rest(`repos/${repo}/contents${dir ? `/${dir}` : ""}`).catch((err) => (err instanceof GhError && err.status === 404 ? [] : Promise.reject(err)))));
  const entries = lists.map((list) => (Array.isArray(list) ? list : []));
  // A license counts at the root only (the docs page does not say docs/ or .github/ hold one); a template may be a folder of them.
  const has = (key, re) => (key === "license" ? entries.slice(0, 1) : entries).flat().some((e) => re.test(e.name) && (e.type === "file" || key === "pull_request_template"));
  const files = Object.fromEntries(Object.entries(HEALTH_NAMES).map(([key, re]) => [key, has(key, re)]));
  const found = [Boolean(info.description), ...Object.values(files)];
  const own = `state: gh api repos/${repo}/contents of the root, docs and .github: the share of the six community checks found in the fork's own tree, as GitHub answers 404 for a fork's community profile and publishes no weights`;
  return { ...communityHealth({ health_percentage: Math.round((100 * found.filter(Boolean).length) / found.length), description: info.description, files }), source: own };
}

const METRICS = {
  "insights.community_health_pct": {
    source: "state: gh api repos/{repo}/community/profile, GitHub's health percentage and the files it found; on a fork, where GitHub answers 404, the share of the same six checks found in the repo's own tree (repos/{repo}/contents of the root, docs and .github)",
    run: async ({ gh, repo }) => {
      try {
        return communityHealth(await gh.rest(`repos/${repo}/community/profile`));
      } catch (err) {
        if (!(err instanceof GhError) || err.status !== 404) throw err;
        const info = await gh.rest(`repos/${repo}`);
        if (!info?.fork) throw err;
        return forkHealth(gh, repo, info);
      }
    },
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
    return [id, { source, ...result, read_at: new Date().toISOString() }];
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
