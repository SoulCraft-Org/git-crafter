// GitHub collector for the Quality, Speed and Consumption page. It fills the
// Issues tab (id `issues`: issues, their types, forms and labels, and how visual their cards are), the
// Projects tab (id `projects`: the board's cards), Pull requests, Security and quality (id `security`: the
// five features of GitHub's Security and quality tab, their open findings,
// and the repo's settings), and
// the Actions tab's checks of the workflow files.
//
// collect() returns one entry per active metric id in targets/github.json:
// { value, detail?, source, read_at } when it measured, or
// { could_not_check, source } when it could not. It never throws for a missing
// tool, token or file, because could not verify is not the same as 0.
//
// Every read goes through `gh api` (REST and GraphQL), so the same code runs in
// CI on GITHUB_TOKEN and in a local session on a person's login. The targets
// file's `needs` field decides what ci mode skips: GITHUB_TOKEN cannot read
// Dependabot alerts, security_and_analysis, branch protection or Projects, so
// those wait for a --local run.
//
// The engine calls collect({ root, mode, params, targets }): params are this
// file's template params with the repo's overrides merged over them, and
// targets the active entries of its targets file. The repo is params.repo, or
// GITHUB_REPOSITORY, which every Actions run sets; its default branch comes
// from the API. The other params:
//   bug_type         the issue type that marks a bug; "Bug" is GitHub's default type
//   bug_label        the label that marks a bug on a user's repo, which has no
//                    issue types; "bug" is GitHub's default label
//   area_labels      the labels that name the area an issue affects
//   issue_types      the issue types an issue may have (Bug, Task); an open
//                    issue of another type, or of none, is work for the board.
//                    Empty turns the type checks off
//   park_hours       hours an open issue of another type may wait before it
//                    counts as parked (24)
//   record_minutes   an issue closed by hand within this many minutes of
//                    opening is a record of work already done, left out of
//                    the closed-issue metrics (5); 0 counts every close
//   project_title    the owner's project board to read; empty means the repo name
//   project_workflows  the built-in workflows its board should have on ("Item
//                    added to project", "Pull request linked to issue", "Item
//                    closed", "Pull request merged", "Auto-add to project")
//   card_words       words of prose a board card may carry and still read at a
//                    glance (75)
//   project_columns  its Status options in board order: the last is done, the
//                    one before it is in progress. GitHub's default board has
//                    Todo, In Progress and Done
//   site_url         the production URL whose response headers are checked
//   not_reviewed     path patterns whose lines a reviewer does not read
//   pr_body_ignore   patterns cut from a PR, issue or card body before its
//                    words count, such as a footer a bot appends; the default
//                    cuts Blacksmith codesmith's, which any repo with its app gets
//   cooldown_days    days a new package version waits before it is used (14)
//   registries       the npm registries a lockfile may resolve from: https
//                    URLs; a package is on one only on its host, under its path
//   max_registry_reads  registry requests one run may make: HEADs of
//                    downloads, and full package documents to confirm a
//                    publish time a Last-Modified header says is recent (100)
//   credential_patterns  paths that .claude/settings.json should deny Read on
//   threat_model     the threat model's path in the repo (THREAT-MODEL.md),
//                    or a list of paths when it spans files: all must exist
//   threat_model_covers  git pathspecs of the code it covers, such as the
//                    Worker's; a change there after the model's makes it stale
//   threat_model_grace_days  days the model may trail that code and still read
//                    current (0)
//   review_apps      GitHub App slugs whose check runs can be a security review
//   review_authors   bot logins whose reviews and comments can be one, as
//                    GraphQL gives them (claude, not claude[bot]); a user
//                    account of the same name never counts
//   security_review  a pattern naming a security review: a check run's name,
//                    or the first line of a review or comment
//   review_paths     globs of the files a security review is for, such as
//                    the code and workflows; a merged PR that changes none is
//                    left out. Empty means every merged PR

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import YAML from "yaml";
import { TARGETS_FILE, LOCAL_REFRESH, NEEDS, repoOf, ConfigError, refusingGh, GhError, ghClient, adminGh, clientFor, pct, skip, measured, count, flag, tally } from "./github-core.mjs";

import { settings } from "./github-settings.mjs";

import { loaders, securityAndAnalysis, on } from "./github-loaders.mjs";
import { feature, whileOn, reasonFor } from "./github-helpers.mjs";
import { ISSUE_METRICS, ACTION_METRICS, PROJECT_METRICS } from "./github-metrics-work.mjs";
import { PULL_METRICS } from "./github-metrics-pulls.mjs";
import { SECURITY_HARDENING_METRICS, SECURITY_REVIEW_METRICS } from "./github-metrics-security.mjs";
export { runsPullRequestCode } from "./github-helpers.mjs";
export { readProject } from "./github-reads.mjs";
export { projectSettings } from "./github-settings.mjs";
export { reviewMarkers, privateMarkerAuthors, NOT_REVIEWED, isNotReviewed, reviewedLines, fixedAfterReview, reverts } from "./github-reviews.mjs";
export { PULL_FIELDS, MARKER_FIELDS } from "./github-queries.mjs";
export { prRefs, causes } from "./github-refs.mjs";
export { proseWords, hasTable, hasVisual, hasPicture, linksIssue } from "./github-text.mjs";
export { lockPackages, pulledBy, denyCovers, registryOf } from "./github-lock.mjs";
export { repoOf, ConfigError, refusingGh, GhError, ghClient, percentile } from "./github-core.mjs";

export const area = "github";
// Reads the GitHub API: collect.mjs skips it under the API reserve (ci.json params.api_reserve).
export const githubApi = true;

// This file's own targets and params: the defaults when the engine passes none
// (tests, a direct call). Params are the union over the entries that carry them.
const OWN_TARGETS = JSON.parse(readFileSync(new URL("../../targets/github.json", import.meta.url), "utf8"));
const OWN_PARAMS = Object.assign({}, ...OWN_TARGETS.map((t) => t.params ?? {}));
const SEVERITIES = ["critical", "high", "medium", "low"];
// ---------------------------------------------------------------- settings

// ---------------------------------------------------------------- gh client

// ---------------------------------------------------------------- queries

// ---------------------------------------------------------------- helpers

// ---------------------------------------------------------------- loaders

// ---------------------------------------------------------------- supply chain

// ---------------------------------------------------------------- metrics

const SECURITY_FEATURE_METRICS = {
  // Security -----------------------------------------------------------------
  // GitHub features: one per row of GitHub's Security and quality tab, on or
  // off now. A feature that is off is a miss, never could_not_check, even
  // when this plan charges for it.
  "security.policy_on": {
    source: "gh api graphql: repository.isSecurityPolicyEnabled (a SECURITY.md in the repo, or the organization's)",
    async run(L) {
      const isOn = await L.securityPolicy();
      return feature(L, isOn, null, isOn ? [] : [count("add SECURITY.md to the repo, .github or docs, or to the organization's .github repo", 0)]);
    },
  },
  "security.dependabot_alerts_on": {
    source: "gh api graphql: repository.hasVulnerabilityAlertsEnabled",
    async run(L) {
      return feature(L, await L.vulnerabilityAlerts(), null);
    },
  },
  "security.code_scanning_on": {
    source: "gh api repos/{repo}/code-scanning/default-setup (state) and code-scanning/analyses",
    async run(L) {
      return feature(L, await L.codeScanningOn(), "code_security");
    },
  },
  "security.secret_scanning_on": {
    source: "gh api repos/{repo} (security_and_analysis: secret_scanning and secret_scanning_push_protection)",
    async run(L) {
      const s = await L.secretScanningOn();
      return feature(L, s.secret && s.push, "secret_protection", [flag("secret scanning", s.secret), flag("push protection", s.push)]);
    },
  },
  "security.code_quality_on": {
    source: "gh api repos/{repo}/code-quality/setup (state)",
    async run(L) {
      return feature(L, await L.codeQualityOn(), "code_quality");
    },
  },

  // Open findings, per feature.
  "security.dependabot_open": {
    source: "gh api repos/{repo}/dependabot/alerts --paginate (open alerts that are vulnerabilities, by security_advisory.severity; malware left out)",
    async run(L) {
      const open = (await L.alerts()).filter((a) => a.state === "open" && a.security_advisory?.classification !== "malware");
      return measured(open.length, tally(open.map((a) => a.security_advisory.severity), SEVERITIES));
    },
  },
  "security.malware_open": {
    source: "gh api repos/{repo}/dependabot/alerts --paginate (open alerts whose security_advisory.classification is malware)",
    async run(L) {
      const open = (await L.alerts()).filter((a) => a.state === "open" && a.security_advisory?.classification === "malware");
      return measured(open.length, open.length ? open.map((a) => count(a.security_advisory.summary ?? a.security_advisory.ghsa_id ?? "malware", 1)) : undefined);
    },
  },
  "security.code_scanning_open": {
    source: "gh api repos/{repo}/code-scanning/alerts --paginate (open alerts, by rule.security_severity_level or rule.severity)",
    async run(L) {
      return whileOn(await L.codeScanningOn(), "Code scanning", async () => {
        const open = (await L.codeScanningAlerts()).filter((a) => a.state === "open");
        return measured(open.length, tally(open.map((a) => a.rule?.security_severity_level ?? a.rule?.severity ?? "unknown"), SEVERITIES));
      });
    },
  },
  "security.secret_scanning_open": {
    source: "gh api repos/{repo}/secret-scanning/alerts --paginate (open alerts, by secret_type_display_name)",
    async run(L) {
      return whileOn((await L.secretScanningOn()).secret, "Secret scanning", async () => {
        const open = (await L.secretScanningAlerts()).filter((a) => a.state === "open");
        return measured(open.length, tally(open.map((a) => a.secret_type_display_name ?? a.secret_type ?? "secret")));
      });
    },
  },
  "security.code_quality_open": {
    source: "gh api repos/{repo}/code-quality/findings?state=open --paginate (by rule.severity)",
    async run(L) {
      return whileOn(await L.codeQualityOn(), "Code quality", async () => {
        const open = await L.codeQualityFindings();
        return measured(open.length, tally(open.map((f) => f.rule?.severity ?? "unknown")));
      });
    },
  },
  "security.headers": {
    source: "HEAD {site}",
    async run(L, { cfg }) {
      if (!cfg.siteUrl) return skip(`params.site_url in ${TARGETS_FILE} is empty: name the production URL whose headers to check`);
      const h = await L.headers();
      const hsts = /max-age=(\d+)/i.exec(h.get("strict-transport-security") ?? "");
      const referrer = (h.get("referrer-policy") ?? "").trim().toLowerCase();
      const detail = [
        flag("Content-Security-Policy", h.get("content-security-policy")),
        flag("Strict-Transport-Security", hsts && Number(hsts[1]) > 0),
        flag("X-Content-Type-Options", (h.get("x-content-type-options") ?? "").trim().toLowerCase() === "nosniff"),
        flag("Referrer-Policy", referrer && referrer !== "unsafe-url"),
      ];
      return measured(detail.reduce((n, d) => n + d.value, 0), detail);
    },
  },
};

const SETTINGS_METRICS = {
  // Settings -----------------------------------------------------------------
  "settings.main_protected": {
    source: "gh api repos/{repo}/branches/{branch}/protection and repos/{repo}/rules/branches/{branch}, {branch} the default branch: a pull request required, force pushes blocked, deletion blocked",
    async run(L) {
      const p = await L.protection();
      const detail = [
        flag("requires a pull request", p.requirePr),
        flag("blocks force pushes", p.blockForcePush),
        flag("blocks deletion", p.blockDeletion),
        count("ruleset rules on the default branch", p.rulesets),
      ];
      return measured(p.requirePr && p.blockForcePush && p.blockDeletion ? 1 : 0, detail);
    },
  },
  "settings.required_checks": {
    source: "gh api repos/{repo}/branches/{branch}/protection and repos/{repo}/rules/branches/{branch} (required_status_checks), {branch} the default branch",
    async run(L) {
      const { checks } = await L.protection();
      return measured(checks.length, checks.map((c) => flag(c, true)));
    },
  },
  "settings.dependabot_security_updates": {
    source: "gh api repos/{repo} (security_and_analysis.dependabot_security_updates)",
    async run(L) {
      return measured(on((await securityAndAnalysis(L)).dependabot_security_updates?.status));
    },
  },
  "settings.pages_private": {
    source: "gh api repos/{repo}/pages (public); repos/{repo} (private, owner type) and orgs/{owner} (plan), as only GitHub Enterprise Cloud publishes private Pages",
    async run(L) {
      // Only a private or internal repo of an organization on GitHub
      // Enterprise Cloud can publish a private Pages site (GitHub docs,
      // Changing the visibility of your GitHub Pages site); any other repo
      // could never meet the goal, so it is not measured.
      const repo = await L.repo();
      if (repo.private === false) return skip("a public repo publishes a public Pages site: private Pages needs a private repo on GitHub Enterprise Cloud");
      if (repo.owner?.type === "User") return skip("a user's repo publishes a public Pages site: private Pages needs an organization on GitHub Enterprise Cloud");
      const plan = await L.plan();
      if (plan && plan !== "enterprise") return skip(`the organization's plan is ${plan}: private Pages needs GitHub Enterprise Cloud`);
      try {
        return measured((await L.pages()).public === false ? 1 : 0);
      } catch (err) {
        if (err instanceof GhError && err.status === 404) return skip("Pages is not enabled on this repo yet (gh api pages: HTTP 404)");
        throw err;
      }
    },
  },
  "settings.dependabot_grouping": {
    source: ".github/dependabot.yml (updates[].groups)",
    async run(L, { root }) {
      const file = [".github/dependabot.yml", ".github/dependabot.yaml"].map((f) => path.join(root, f)).find(existsSync);
      if (!file) return skip("no .github/dependabot.yml under root");
      const updates = YAML.parse(readFileSync(file, "utf8"))?.updates ?? [];
      if (!updates.length) return skip(".github/dependabot.yml has no updates entries");
      const detail = updates.map((u) => flag(u["package-ecosystem"], u.groups && Object.keys(u.groups).length));
      return measured(pct(detail.filter((d) => d.value).length, updates.length), detail);
    },
  },
};

const METRICS = {...ISSUE_METRICS, ...PULL_METRICS, ...ACTION_METRICS, ...PROJECT_METRICS, ...SECURITY_FEATURE_METRICS, ...SECURITY_HARDENING_METRICS, ...SECURITY_REVIEW_METRICS, ...SETTINGS_METRICS};

export const METRIC_IDS = Object.keys(METRICS);

/**
 * Reads the GitHub metrics among `targets`. `params` and `targets` come from
 * the engine; this file's own are the defaults. `gh`, `admin`, `fetch`, `now`,
 * `repo` and `sleep` are injectable for tests; the defaults are the real `gh`
 * CLI, gh on ADMIN_READ_TOKEN for a CI run's admin reads (null when unset),
 * the global fetch, the clock, params.repo or GITHUB_REPOSITORY, and a timer.
 */
export async function collect({
  root = process.cwd(),
  mode = "local",
  params = OWN_PARAMS,
  targets = OWN_TARGETS,
  gh = ghClient(),
  admin = adminGh(),
  fetch: fetchImpl = globalThis.fetch,
  now = Date.now(),
  repo,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  // Only the metrics the engine keeps: a dropped one is never read.
  const active = Object.entries(METRICS).filter(([id]) => targets.some((t) => t.id === id));
  const slug = repoOf(repo, params);
  let cfg;
  try {
    cfg = settings(params, slug);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return Object.fromEntries(active.map(([id]) => [id, { could_not_check: err.message, source: TARGETS_FILE }]));
  }
  if (!slug) gh = refusingGh(`no repo to read: params.repo in ${TARGETS_FILE} is not owner/name, and GITHUB_REPOSITORY is unset`);
  if (!slug && admin) admin = gh;
  const needsById = new Map(targets.map((t) => [t.id, t.needs]));
  const ctx = { root, mode, now: Number(now), repo: slug, sleep, cfg, fetchImpl };
  const L = loaders({ gh, repo: slug, root, cfg, fetchImpl });
  // A CI run reads its github-admin metrics with ADMIN_READ_TOKEN's loaders, or not at all.
  const LA = admin ? loaders({ gh: admin, repo: slug, root, cfg, fetchImpl }) : null;
  const fill = (text) => text.replaceAll("{repo}", slug ?? "owner/name").replaceAll("{project}", cfg.projectTitle).replaceAll("{site}", cfg.siteUrl || "params.site_url");
  const entries = await Promise.all(
    active.map(async ([id, metric]) => {
      const source = fill(metric.source);
      const needs = needsById.get(id);
      const client = clientFor({ mode, needs, gh: L, admin: LA });
      if (client.skip) return [id, { could_not_check: client.skip, source }];
      if (mode === "ci" && needs === "project-scope") return [id, { could_not_check: `${NEEDS["project-scope"]}; ${LOCAL_REFRESH}`, source }];
      try {
        const { note, ...result } = await metric.run(client.gh, ctx);
        if (result.could_not_check) return [id, { could_not_check: result.could_not_check, source }];
        return [id, { ...result, source: note ? `${source}; ${note}` : source, read_at: new Date().toISOString() }];
      } catch (err) {
        return [id, { could_not_check: reasonFor(err, needs, mode), source }];
      }
    }),
  );
  return Object.fromEntries(entries);
}
