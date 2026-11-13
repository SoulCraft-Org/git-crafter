// The GitHub collector's Actions-hardening, supply-chain and Claude Code metrics: each reads through the loaders and returns measured(...) or skip(...).
import { measured, flag, skip, pct, count, round1, TARGETS_FILE, DAY } from "./github-core.mjs";
import { workflowsOr, prtJobs, fixedAlerts, openAlerts, PAID } from "./github-helpers.mjs";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import YAML from "yaml";
import { lockPackages, readJson, registryOf, gitAt } from "./github-lock.mjs";
import { youngPackages } from "./github-young.mjs";

export const SECURITY_HARDENING_METRICS = {
  // Actions hardening (GitHub docs, Security hardening for GitHub Actions).
  "security.token_default_read": {
    source: "gh api repos/{repo}/actions/permissions/workflow (default_workflow_permissions, can_approve_pull_request_reviews)",
    async run(L) {
      const w = await L.workflowPermissions();
      return measured(w.default_workflow_permissions === "read" ? 1 : 0, [
        flag("GITHUB_TOKEN reads only, by default", w.default_workflow_permissions === "read"),
        flag("Actions may approve pull requests", w.can_approve_pull_request_reviews === true),
      ]);
    },
  },
  "security.actions_policy_share": {
    source: "gh api repos/{repo}/actions/permissions (allowed_actions, sha_pinning_required)",
    async run(L) {
      const policy = await L.actionsPermissions();
      if (policy.enabled === false) return skip("GitHub Actions is off for this repo, so no policy applies");
      const detail = [flag("Only selected actions may run", ["selected", "local_only"].includes(policy.allowed_actions)), flag("Actions must be pinned to a full commit SHA", policy.sha_pinning_required === true)];
      return measured(pct(detail.filter((d) => d.value).length, detail.length), detail);
    },
  },
  "security.prt_head_checkouts": {
    source: ".github/workflows/*.yml: jobs of a pull_request_target or workflow_run workflow that check out the pull request's code: an actions/checkout of its head ref or repo, gh pr checkout, or a git fetch or checkout of refs/pull/*",
    async run(L) {
      const files = await workflowsOr(L);
      if (files.could_not_check) return files;
      const found = files.flatMap(prtJobs);
      return measured(found.length, found.length ? found : undefined);
    },
  },

  // Supply chain (OpenSSF S2C2F; GitHub docs, Dependabot options reference).
  "security.dependabot_cooldown": {
    source: ".github/dependabot.yml: updates[].cooldown, the shortest of default-days and semver-*-days, against params.cooldown_days",
    async run(L, { root, cfg }) {
      const file = [".github/dependabot.yml", ".github/dependabot.yaml"].map((f) => path.join(root, f)).find(existsSync);
      if (!file) return skip("no .github/dependabot.yml under root");
      const updates = YAML.parse(readFileSync(file, "utf8"))?.updates ?? [];
      if (!updates.length) return skip(".github/dependabot.yml has no updates entries");
      const days = (u) => {
        const c = u.cooldown ?? {};
        const set = ["default-days", "semver-major-days", "semver-minor-days", "semver-patch-days"].map((k) => c[k]).filter((v) => typeof v === "number");
        return set.length ? Math.min(...set) : 0;
      };
      const detail = updates.map((u) => ({ label: `${u["package-ecosystem"]} ${u.directory ?? "/"}`, value: days(u), unit: "days" }));
      return measured(pct(detail.filter((d) => d.value >= cfg.cooldownDays).length, detail.length), detail);
    },
  },
  "security.lockfile_registry_share": {
    source: "package-lock.json at the root: each package's resolved URL against params.registries, parsed: https, the registry's host, under its path",
    async run(L, { root, cfg }) {
      const pkgs = lockPackages(readJson(path.join(root, "package-lock.json")));
      if (!pkgs) return skip("no package-lock.json with a packages map at the root");
      const resolved = pkgs.filter((p) => p.resolved);
      if (!resolved.length) return skip("no package in package-lock.json names where it resolved from");
      const off = resolved.filter((p) => !registryOf(p.resolved, cfg.registries));
      return measured(pct(resolved.length - off.length, resolved.length), [
        count("from an allowed registry", resolved.length - off.length),
        ...off.slice(0, 5).map((p) => count(`${p.name}: ${p.resolved.replace(/^([\w+.-]+:\/\/[^/]+).*$/, "$1")}`, 1)),
      ]);
    },
  },
  "security.young_lockfile_packages": {
    source: "package-lock.json at the root against itself params.cooldown_days ago (git); for each entry added since on an allowed registry, a HEAD of its download for Last-Modified, then the registry's full document only where that is recent; no redirects, at most params.max_registry_reads requests",
    async run(L, { root, now, cfg, fetchImpl }) {
      const got = await youngPackages(root, now, cfg, fetchImpl);
      if (got.skip) return skip(got.skip);
      const rows = got.young.slice(0, 10).map((p) => ({
        label: `${p.name} ${p.version}, via ${[...(got.reach.get(p.path) ?? [])].join(", ") || p.path}`,
        value: round1(p.days),
        unit: "days old",
      }));
      return measured(got.young.length, [
        ...rows,
        count("entries added within the cooldown", got.fresh),
        count("downloads asked for Last-Modified (no body)", got.heads),
        count("full documents fetched to confirm", got.docs),
        ...(got.unasked ? [count("entries from no allowed registry, not asked", got.unasked)] : []),
      ]);
    },
  },

  // Microsoft SDL, practice 3: security design review and threat modeling.
  "security.threat_model_current": {
    source: "git log at the root: the latest commit to any params.threat_model file against the latest to params.threat_model_covers",
    async run(L, { root, cfg }) {
      if (!cfg.threatModelCovers.length) return skip(`params.threat_model_covers in ${TARGETS_FILE} is empty: list the paths the threat model covers, such as the Worker's`);
      const git = gitAt(root);
      let model, code, missing;
      try {
        if (git("rev-parse", "--is-shallow-repository") === "true") return skip("the checkout is shallow; the threat model's history needs a full clone (fetch-depth: 0) or a --local run");
        const last = (paths) => Number(git("log", "-1", "--format=%ct", "--", ...paths)) * 1000 || null;
        [model, code] = [last(cfg.threatModels), last(cfg.threatModelCovers)];
        // git log names the commit that deleted a file as its latest change, so each file must be at HEAD.
        missing = cfg.threatModels.filter((file) => {
          try {
            git("cat-file", "-e", `HEAD:./${file}`);
            return false;
          } catch {
            return true;
          }
        });
      } catch (err) {
        return skip(`git could not read the threat model's history: ${err.message.split("\n")[0]}`);
      }
      if (!code) return skip("no commit touches params.threat_model_covers yet");
      const day = (t) => new Date(t).toISOString().slice(0, 10);
      if (missing.length) return measured(0, [count(`no ${missing.join(", ")} at HEAD; the covered code changed ${day(code)}`, 0)]);
      const behind = round1(Math.max(0, (code - model) / DAY));
      return measured(model >= code - cfg.threatModelGraceDays * DAY ? 1 : 0, [{ label: `${cfg.threatModels.join(", ")} ${day(model)}; the covered code ${day(code)}`, value: behind, unit: "days behind" }]);
    },
  },
};

export const SECURITY_REVIEW_METRICS = {
  // Claude Code (Anthropic docs: Claude Code security).
  "security.claude_review_share": {
    source: "gh api graphql: the last 20 merged pullRequests: a head check run from an app in params.review_apps named like params.security_review, or a review or comment by a Bot whose login is in params.review_authors and whose first line starts with it",
    async run(L, { cfg }) {
      const all = await L.securityReviews();
      if (!all.length) return skip("no merged PRs yet");
      // Only the PRs that change a file params.review_paths names, when it names any.
      const files = new Map((await L.merged()).map((p) => [p.number, (p.files?.nodes ?? []).map((f) => f.path)]));
      const inScope = (p) => (files.get(p.number) ?? []).some((f) => cfg.reviewPaths.some((re) => re.test(f)));
      const pulls = cfg.reviewPaths.length ? all.filter(inScope) : all;
      if (!pulls.length) return skip("no merged PR among the last 20 changes a file params.review_paths names");
      const firstLine = (b) => String(b ?? "").split("\n").find((l) => l.trim()) ?? "";
      // Only Claude's app or bot counts: anyone else's comment, however it is headed, never does.
      // A User can take a bot's login (a "claude" account exists), so the author must be a Bot.
      const byClaude = (n) => n.author?.__typename === "Bot" && cfg.reviewAuthors.includes(n.author.login);
      const reviewed = pulls.filter((p) => {
        const suites = p.commits?.nodes?.[0]?.commit?.checkSuites?.nodes ?? [];
        const checks = suites.filter((cs) => cfg.reviewApps.includes(cs.app?.slug ?? "")).flatMap((cs) => cs.checkRuns?.nodes ?? []);
        const notes = [...(p.comments?.nodes ?? []), ...(p.reviews?.nodes ?? [])].filter(byClaude);
        return checks.some((c) => cfg.securityReview.check.test(c.name ?? "")) || notes.some((n) => cfg.securityReview.line.test(firstLine(n.body)));
      });
      const left = all.length - pulls.length;
      return measured(pct(reviewed.length, pulls.length), [
        count("with a security review from Claude", reviewed.length),
        count("merged PRs read", pulls.length),
        ...(left ? [count("merged PRs outside params.review_paths, left out", left)] : []),
      ]);
    },
  },

  // Speed: how long the latest fix took, and the oldest still open.
  "security.latest_fix_days": {
    source: "gh api dependabot/alerts (fixed_at), and code-scanning/alerts (fixed_at) and secret-scanning/alerts (resolved_at, revoked) while those features are on: the latest fixed alert, days from created_at",
    async run(L) {
      const [latest] = await fixedAlerts(L);
      if (!latest) return skip("no alert has been fixed yet");
      const days = round1((Date.parse(latest.fixedAt) - Date.parse(latest.createdAt)) / DAY);
      return measured(days, [{ label: `latest fix: ${latest.kind}`, value: days, unit: "days" }]);
    },
  },
  "security.oldest_open_alert_days": {
    source: "gh api dependabot/alerts, and code-scanning/alerts and secret-scanning/alerts while those features are on, and code-quality/findings unless it answers that code quality is off: the oldest open one's age at read time",
    async run(L, { now }) {
      const open = await openAlerts(L);
      if (!open.length) return measured(0, [count("open alerts", 0)]);
      const oldest = open.reduce((a, b) => (Date.parse(a.createdAt) <= Date.parse(b.createdAt) ? a : b));
      const days = round1((now - Date.parse(oldest.createdAt)) / DAY);
      return measured(days, [{ label: `oldest: ${oldest.kind}`, value: days, unit: "days" }, count("open alerts read", open.length)]);
    },
  },

  // Consumption: what the paid features bill now.
  "security.features_dollars_per_month": {
    source: "gh api orgs/{owner}/settings/billing/advanced-security (active committers billed, per product) times the list price: Code Security $30, Secret Protection $19 per active committer a month (github.com/security/plans, read 2026-11-03)",
    async run(L) {
      if ((await L.repo()).owner?.type === "User") return skip("a user's repo has no organization billing to read");
      const c = await L.committers();
      const detail = [
        { label: `Code Security: ${c.code_security} active committers`, value: c.code_security * PAID.code_security.price },
        { label: `Secret Protection: ${c.secret_protection} active committers`, value: c.secret_protection * PAID.secret_protection.price },
      ];
      return measured(detail.reduce((n, d) => n + d.value, 0), detail);
    },
  },
};
