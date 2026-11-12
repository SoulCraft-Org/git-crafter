// The Settings tab's collector: what a repo's GitHub Settings pages hold now, read with gh api.
// Detail rows are counts and on/off flags only, never a login, a secret's name or a URL.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { adminGh, clientFor, ConfigError, count, flag, ghClient, HOUR, measured, NEEDS, refusingGh, repoOf, round1, skip } from "../github/github-core.mjs";
import { reasonFor } from "../github/github-helpers.mjs";
import { branchSets, reaches, reads, rulesOf, secretsRead } from "./repo-settings-reads.mjs";

export const area = "settings";
// Reads the GitHub API: collect.mjs skips it under the API reserve (ci.json params.api_reserve).
export const githubApi = true;
const TARGETS_FILE = "targets/repo-settings.json";
const TARGETS = JSON.parse(readFileSync(new URL("../../targets/repo-settings.json", import.meta.url), "utf8"));
const TEMPLATE = Object.assign({}, ...TARGETS.map((t) => t.params ?? {}));

// A ConfigError naming the param when `ok` is false.
function need(ok, param, shape) {
  if (!ok) throw new ConfigError(`params.${param} in ${TARGETS_FILE} must ${shape}`);
}

const isScalar = (v) => ["boolean", "string", "number"].includes(typeof v);
const isMap = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

// The params this collector reads, checked.
function settings({ expected, blocked_paths: blockedPaths, included_cache_gb: includedCacheGb }) {
  need(isMap(expected) && Object.values(expected).every(isScalar), "expected", "map repo fields to true, false, a string or a number");
  need(Array.isArray(blockedPaths) && blockedPaths.every((p) => typeof p === "string"), "blocked_paths", "be a list of strings");
  need(typeof includedCacheGb === "number" && includedCacheGb > 0, "included_cache_gb", "be a number above 0");
  return { expected, blockedPaths, includedCacheGb };
}

// One protection: null when the repo has nothing for it to guard, { hidden } when the token cannot see it.
async function bypassRow(R) {
  const sets = await branchSets(R);
  const classic = await R.classic();
  if (!sets.length && !classic) return null;
  if (sets.some((s) => s.bypass_actors === undefined)) return { hidden: `a ruleset's bypass list is hidden from this token: ${NEEDS["github-admin"]}` };
  const open = sets.some((s) => s.bypass_actors.length) || classic?.enforce_admins?.enabled === false;
  return { label: "No one can bypass the default branch's rules", ok: !open };
}

async function tagsRow(R) {
  const tag = await R.firstTag();
  if (!tag) return null;
  const ref = `refs/tags/${tag.name}`;
  const types = new Set((await R.rulesets()).filter((s) => s.target === "tag" && reaches(s, ref)).flatMap((s) => (s.rules ?? []).map((r) => r.type)));
  return { label: "Tags cannot be deleted or moved", ok: types.has("deletion") && types.has("update") };
}

// GitHub applies push rules to private and internal repos only, so a public repo has no row.
async function pushRow(R, cfg) {
  const repo = await R.repo();
  if (repo.private === false || !cfg.blockedPaths.length) return null;
  const pushSets = (await R.rulesets()).filter((s) => s.target === "push");
  const blocked = new Set(rulesOf(pushSets, "file_path_restriction").flatMap((r) => r.parameters?.restricted_file_paths ?? []));
  return { label: "A push rule blocks secret file names", ok: cfg.blockedPaths.every((p) => blocked.has(p)) };
}

async function environmentsRow(R) {
  const envs = await R.environments();
  if (!envs.length) return null;
  return { label: "Every environment deploys from named branches only", ok: envs.every((e) => Boolean(e.deployment_branch_policy)) };
}

// The pull request rules on the default branch, rulesets' and classic protection's, in one shape.
async function reviewRules(R) {
  const fromSets = rulesOf(await branchSets(R), "pull_request").map((r) => r.parameters ?? {});
  const classic = (await R.classic())?.required_pull_request_reviews;
  if (!classic) return fromSets;
  return [...fromSets, { ...classic, require_code_owner_review: classic.require_code_owner_reviews }];
}

const sum = (rows) => rows.reduce((n, r) => n + r.value, 0);

const METRICS = {
  "settings.protections_missing": {
    source: "state: gh api repos/{repo}/rulesets and each active one (bypass_actors, tag rules deletion and update, push rule file_path_restriction against params.blocked_paths), branches/{branch}/protection (enforce_admins), tags (the first listed), environments (deployment_branch_policy); a row with nothing to guard is left out",
    async run(R, cfg) {
      const rows = (await Promise.all([bypassRow(R), tagsRow(R), pushRow(R, cfg), environmentsRow(R)])).filter(Boolean);
      const hidden = rows.find((r) => r.hidden);
      if (hidden) return skip(hidden.hidden);
      if (!rows.length) return skip("this repo has no ruleset, tag or environment to guard yet");
      return measured(rows.filter((r) => !r.ok).length, rows.map((r) => flag(r.label, r.ok)));
    },
  },
  "settings.general_drift": {
    source: "state: gh api repos/{repo}, each field named in params.expected against its value there",
    async run(R, cfg) {
      const keys = Object.keys(cfg.expected);
      if (!keys.length) return skip(`params.expected in ${TARGETS_FILE} is empty: name the General settings this repo holds itself to`);
      const repo = await R.repo();
      const unseen = keys.find((k) => repo[k] === undefined);
      if (unseen) return skip(`gh api repos answered without ${unseen}: ${NEEDS["github-admin"]}`);
      const rows = keys.map((k) => flag(`${k} is ${cfg.expected[k]}`, repo[k] === cfg.expected[k]));
      return measured(rows.filter((r) => !r.value).length, rows);
    },
  },
  "settings.outside_access": {
    source: "state: gh api repos/{repo}/collaborators?affiliation=outside and repos/{repo}/invitations, counted",
    async run(R) {
      const rows = [count("outside collaborators", (await R.outside()).length), count("pending invitations", (await R.invitations()).length)];
      return measured(sum(rows), rows);
    },
  },
  "settings.unused_secrets": {
    source: "state: gh api repos/{repo}/actions/secrets and each environment's secrets (names only), against secrets.NAME in .github/workflows/*.yml of the checkout",
    async run(R) {
      const names = await R.secretNames();
      const read = secretsRead(names, await R.workflows());
      if (names.length && read === null) return skip("a workflow passes every secret on (secrets: inherit) or reads one by a computed name, so its files cannot show which are used");
      return measured(names.length - (read ?? 0), [count("secrets stored", names.length), count("read by a workflow", read ?? 0)]);
    },
  },
  "settings.person_waits": {
    source: "state: pull_request rules of the active rulesets on {branch} and of branches/{branch}/protection (approvals, code owner review, last-push approval, required reviewers), and each environment's protection_rules (required_reviewers, wait_timer)",
    async run(R) {
      const rules = await reviewRules(R);
      const envRules = (await R.environments()).flatMap((e) => e.protection_rules ?? []);
      const rows = [
        count("rules requiring an approval", rules.filter((p) => p.required_approving_review_count > 0).length),
        count("rules requiring a code owner's review", rules.filter((p) => p.require_code_owner_review).length),
        count("rules requiring approval of the last push", rules.filter((p) => p.require_last_push_approval).length),
        count("rules naming required reviewers", rules.filter((p) => p.required_reviewers?.length).length),
        count("environments with required reviewers", envRules.filter((r) => r.type === "required_reviewers").length),
        count("environments with a wait timer", envRules.filter((r) => r.type === "wait_timer" && r.wait_timer > 0).length),
      ];
      return measured(sum(rows), rows);
    },
  },
  "settings.metered_on": {
    source: "state: gh api repos/{repo}/actions/cache/storage-limit (max_cache_size_gb against params.included_cache_gb) and the active rulesets' copilot_code_review rules; not measured for a public repo",
    async run(R, cfg) {
      if ((await R.repo()).private === false) return skip("a public repo is not billed for Actions cache or a Copilot review, so nothing here can bill it");
      const rows = [count("rulesets that ask for a Copilot review", (await R.rulesets()).filter((s) => rulesOf([s], "copilot_code_review").length).length)];
      const limit = await R.cacheLimit();
      if (limit) rows.push(count("cache size limit above the included size", limit.max_cache_size_gb > cfg.includedCacheGb ? 1 : 0));
      return measured(sum(rows), rows);
    },
  },
  "settings.admin_read_age_hours": {
    source: "state: generated_at of local.json in the repo's data folder, the last collect.mjs --local run, against the time of this run",
    async run(R, cfg, { mode, data, now }) {
      if (mode !== "ci") return skip("this run is the refresh; the next CI run reads its age");
      const file = path.join(data, "local.json");
      if (!existsSync(file)) return skip("no signed-in run is recorded yet: run collect.mjs --local");
      const at = Date.parse(JSON.parse(readFileSync(file, "utf8")).generated_at);
      if (!Number.isFinite(at)) return skip("local.json holds no generated_at");
      return measured(round1(Math.max(0, now - at) / HOUR));
    },
  },
};

export const METRIC_IDS = Object.keys(METRICS);

// One metric's entry: its value and rows, or why it could not be read.
async function entry(metric, needs, { R, RA, cfg, mode, fill, data, now }) {
  const source = fill(metric.source);
  // A CI run reads an admin metric with ADMIN_READ_TOKEN's reads (RA), or not at all.
  const client = clientFor({ mode, needs, gh: R, admin: RA });
  if (client.skip) return { could_not_check: client.skip, source };
  try {
    const result = await metric.run(client.gh, cfg, { mode, data, now });
    return result.could_not_check ? { ...result, source } : { ...result, source, read_at: new Date().toISOString() };
  } catch (err) {
    return { could_not_check: reasonFor(err, needs, mode), source };
  }
}

/**
 * Reads the Settings metrics among `targets`. `params` and `targets` come from
 * the engine; this file's own are the defaults. `gh`, `admin`, `repo` and `now`
 * are injectable for tests; the defaults are the real gh CLI, gh on
 * ADMIN_READ_TOKEN for a CI run's admin reads (null when unset), params.repo
 * or GITHUB_REPOSITORY, and the clock.
 */
export async function collect({ root = process.cwd(), mode = "local", data = path.resolve(root, "quality/data"), params = TEMPLATE, targets = TARGETS, gh = ghClient(), admin = adminGh(), repo, now = Date.now() } = {}) {
  const active = Object.entries(METRICS).filter(([id]) => targets.some((t) => t.id === id));
  const slug = repoOf(repo, params);
  let cfg;
  try {
    cfg = settings({ ...TEMPLATE, ...params });
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return Object.fromEntries(active.map(([id]) => [id, { could_not_check: err.message, source: TARGETS_FILE }]));
  }
  if (!slug) gh = refusingGh(`no repo to read: params.repo in ${TARGETS_FILE} is not owner/name, and GITHUB_REPOSITORY is unset`);
  if (!slug && admin) admin = gh;
  const R = reads({ gh, repo: slug, root });
  const RA = admin ? reads({ gh: admin, repo: slug, root }) : null;
  const branch = mode === "ci" ? "the default branch" : await R.branch().catch(() => "the default branch");
  const fill = (text) => text.replaceAll("{repo}", slug ?? "owner/name").replaceAll("{branch}", branch);
  const needs = new Map(targets.map((t) => [t.id, t.needs]));
  const entries = await Promise.all(active.map(async ([id, metric]) => [id, await entry(metric, needs.get(id), { R, RA, cfg, mode, fill, data, now: Number(now) })]));
  return Object.fromEntries(entries);
}
