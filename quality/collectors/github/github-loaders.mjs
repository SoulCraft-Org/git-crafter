// The GitHub collector's memoized reads: each runs at most once per collect() and the metrics share it.
import path from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import YAML from "yaml";
import { connection, GhError } from "./github-core.mjs";
import { ISSUES, RECENT_ISSUES, OPEN_ISSUE_TYPES, LABEL_USE, MERGED_PULLS, MERGED_PAGE, OPEN_PULLS, BRANCH_COMMITS, SECURITY_POLICY, VULNERABILITY_ALERTS } from "./github-queries.mjs";
import { readProtection, readProject } from "./github-reads.mjs";
import { diffFiles } from "./github-reviews.mjs";

// Last-N bases, never calendar windows: each metric reads the latest events,
// which new work replaces. The sources in targets/github.json say why each N.
const LAST_MERGED = 20;

/** The files a commit changed against its first parent, as diffFiles reads the gate's diff; null when git cannot diff it here. */
export function gitDiff(root, oid) {
  const r = spawnSync("git", ["-C", root, "diff", "--no-color", "--no-ext-diff", "--unified=0", `${oid}^`, oid], { encoding: "utf8", maxBuffer: 64 << 20 });
  return r.status === 0 ? diffFiles(r.stdout) : null;
}

/** Workflow file contents under root, or null when the folder is missing. */
export function readWorkflows(root) {
  const dir = path.join(root, ".github", "workflows");
  if (!existsSync(dir)) return null;
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((file) => {
      const text = readFileSync(path.join(dir, file), "utf8");
      return { file, text, doc: YAML.parse(text) ?? {} };
    });
}

/**
 * The workflows onboarded to .github/workflows/actions.lock (gh actions-lock),
 * each file name with the uses: lines locked for it: an empty map with no
 * lockfile, a skip when it does not parse.
 */
function readLock(root) {
  const file = path.join(root, ".github", "workflows", "actions.lock");
  if (!existsSync(file)) return new Map();
  try {
    const flows = YAML.parse(readFileSync(file, "utf8"))?.workflows ?? {};
    return new Map(Object.entries(flows).map(([p, uses]) => [path.basename(p), new Set(Array.isArray(uses) ? uses : [])]));
  } catch (err) {
    return { could_not_check: `.github/workflows/actions.lock does not parse as YAML: ${err.message.split("\n")[0]}` };
  }
}

/**
 * The YAML issue forms under root and config.yml, each parsed; a file that
 * does not parse has a null doc, as GitHub rejects it. Null when the folder is
 * missing. Read from the files: GitHub's API lists Markdown templates only,
 * and its isBlankIssuesEnabled answers for the viewer, not the repo.
 */
export function readForms(root) {
  const dir = path.join(root, ".github", "ISSUE_TEMPLATE");
  if (!existsSync(dir)) return null;
  const parse = (file) => {
    try {
      return YAML.parse(readFileSync(path.join(dir, file), "utf8")) ?? {};
    } catch {
      return null;
    }
  };
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/i.test(f)).sort();
  const isConfig = (f) => /^config\.ya?ml$/i.test(f);
  const config = files.filter(isConfig).map(parse)[0];
  return { forms: files.filter((f) => !isConfig(f)).map((file) => ({ file, doc: parse(file) })), config: config ?? {} };
}

/** Memoized reads shared by the metrics; each runs at most once per collect(). */
export function loaders(env) {
  const L = {};
  return Object.assign(L, issueLoaders(L, env), securityLoaders(L, env), repoLoaders(L, env));
}

// A function that calls fn the first time only and returns that same promise after.
// Memoizes a read: fn runs on the first call, and every call shares its promise.
export const once = (fn) => {
  let p;
  return () => (p ??= fn());
};

// Lazy loaders for issues and merged PRs.
function issueLoaders(L, { gh, repo, root, git = gitDiff }) {
  const [owner, name] = repo?.split("/") ?? [];
  const patches = new Map();
  return {
    issues: once(() => connection(gh, ISSUES, { owner, name }, (d) => d.repository.issues)),
    recentIssues: once(async () => (await gh.graphql(RECENT_ISSUES, { owner, name })).repository.issues.nodes),
    // Each open issue's type; null where it has none.
    openTypes: once(() => connection(gh, OPEN_ISSUE_TYPES, { owner, name }, (d) => d.repository.issues)),
    // Every label: archived or not (REST), and how many issues and PRs carry it (GraphQL).
    labels: once(async () => {
      const [rows, used] = await Promise.all([gh.restAll(`repos/${repo}/labels?per_page=100`), connection(gh, LABEL_USE, { owner, name }, (d) => d.repository.labels)]);
      const uses = new Map(used.map((l) => [l.name, l.issues.totalCount + l.pullRequests.totalCount]));
      return rows.map((l) => ({ name: l.name, archived: Boolean(l.archived_at), uses: uses.get(l.name) ?? 0 }));
    }),
    // The last 20 merged PRs, newest merge first.
    merged: once(async () => {
      const pulls = await connection(gh, MERGED_PULLS, { owner, name }, (d) => d.repository.pullRequests, MERGED_PAGE);
      return pulls.sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt)).slice(0, LAST_MERGED);
    }),
    // A merged PR's changed files from its merge commit in the local checkout (diffFiles' shape), so a moved line
    // is read once; null when the commit is not there (another repo, a shallow clone), which moves nothing.
    patch: (pull) => {
      const oid = pull.mergeCommit?.oid;
      if (!oid) return null;
      if (!patches.has(oid)) patches.set(oid, git(root, oid));
      return patches.get(oid);
    },
    open: once(() => connection(gh, OPEN_PULLS, { owner, name }, (d) => d.repository.pullRequests)),
    // Not memoized: the second read after GitHub was still computing mergeability.
    openAgain: () => connection(gh, OPEN_PULLS, { owner, name }, (d) => d.repository.pullRequests),
    branchCommits: once(async () => (await gh.graphql(BRANCH_COMMITS, { owner, name })).repository.defaultBranchRef.target.history.nodes),
  };
}

// Lazy loaders for the repo, its default branch and its security settings.
function securityLoaders(L, { gh, repo }) {
  const [owner, name] = repo?.split("/") ?? [];
  return {
    repo: once(() => gh.rest(`repos/${repo}`)),
    branch: once(async () => {
      const branch = (await L.repo()).default_branch;
      if (!branch) throw new Error(`gh api repos/${repo} answered without a default_branch`);
      return branch;
    }),
    alerts: once(() => gh.restAll(`repos/${repo}/dependabot/alerts?per_page=100`)),
    // GitHub's five Security and quality features, each on or off now.
    securityPolicy: once(async () => (await gh.graphql(SECURITY_POLICY, { owner, name })).repository.isSecurityPolicyEnabled === true),
    vulnerabilityAlerts: once(async () => (await gh.graphql(VULNERABILITY_ALERTS, { owner, name })).repository.hasVulnerabilityAlertsEnabled === true),
    codeScanningOn: once(async () => {
      const setup = await offWhenDisabled(() => gh.rest(`repos/${repo}/code-scanning/default-setup`));
      return setup?.state === "configured" || (await L.codeScanning());
    }),
    secretScanningOn: once(async () => {
      const sa = await securityAndAnalysis(L);
      return { secret: on(sa.secret_scanning?.status), push: on(sa.secret_scanning_push_protection?.status) };
    }),
    codeQualityOn: once(async () => (await offWhenDisabled(() => gh.rest(`repos/${repo}/code-quality/setup`)))?.state === "configured"),
    // Each feature's alerts or findings, read only while the feature is on.
    codeScanningAlerts: once(() => gh.restAll(`repos/${repo}/code-scanning/alerts?per_page=100`)),
    // hide_secret=true: GitHub sends each alert's secret value unless told not
    // to; none may reach this process. Any secret field is dropped as well.
    secretScanningAlerts: once(async () => (await gh.restAll(`repos/${repo}/secret-scanning/alerts?per_page=100&hide_secret=true`)).map(({ secret, ...alert }) => alert)),
    codeQualityFindings: once(() => gh.restAll(`repos/${repo}/code-quality/findings?state=open&per_page=100`)),
  };
}

// Lazy loaders for billing, project, lock files and other repo reads.
function repoLoaders(L, { gh, repo, root, cfg, fetchImpl }) {
  const [owner, name] = repo?.split("/") ?? [];
  return {
    // Active committers the organization is billed for, per paid product.
    committers: once(async () => {
      const out = {};
      for (const product of ["code_security", "secret_protection"]) {
        out[product] = (await gh.rest(`orgs/${owner}/settings/billing/advanced-security?advanced_security_product=${product}`)).total_advanced_security_committers ?? 0;
      }
      return out;
    }),
    codeScanning: once(async () => {
      try {
        return (await gh.rest(`repos/${repo}/code-scanning/analyses?per_page=1`)).length > 0;
      } catch (err) {
        // 404 "no analysis found", or 403 when Code Security is not enabled: both mean off.
        if (err instanceof GhError && (err.status === 404 || /must be enabled/i.test(err.message))) return false;
        throw err;
      }
    }),
    protection: once(() => readProtection(L, gh, repo)),
    pages: once(() => gh.rest(`repos/${repo}/pages`)),
    workflowPermissions: once(() => gh.rest(`repos/${repo}/actions/permissions/workflow`)),
    actionsPermissions: once(() => gh.rest(`repos/${repo}/actions/permissions`)),
    securityReviews: once(() => securityReviews(L, gh, owner, name)),
    // The organization's plan name, or null when this token cannot see it.
    plan: once(async () => {
      try {
        return (await gh.rest(`orgs/${owner}`))?.plan?.name ?? null;
      } catch {
        return null;
      }
    }),
    workflowFiles: once(async () => readWorkflows(root)),
    lockedWorkflows: once(async () => readLock(root)),
    headers: once(async () => {
      const res = await fetchImpl(cfg.siteUrl, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HEAD ${cfg.siteUrl} answered HTTP ${res.status}`);
      return res.headers;
    }),
    project: once(() => readProject(gh, repo, owner, name, cfg)),
  };
}

// Check runs (with their app) and reviews and comments (with their author) of the last merged PRs, one query.
async function securityReviews(L, gh, owner, name) {
  const pulls = await L.merged();
  if (!pulls.length) return [];
  const aliases = pulls.map(
    (p) => `p${p.number}: pullRequest(number: ${p.number}) { number
          comments(last: 20) { nodes { body author { __typename login } } }
          reviews(last: 20) { nodes { body author { __typename login } } }
          commits(last: 1) { nodes { commit { checkSuites(first: 20) { nodes { app { slug } checkRuns(first: 30) { nodes { name } } } } } } } }`,
  );
  const data = await gh.graphql(`query SecurityReviews($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${aliases.join(" ")} } }`, { owner, name });
  return Object.values(data.repository ?? {}).filter(Boolean);
}

// 1 when a status reads "enabled", else 0.
export const on = (status) => (status === "enabled" ? 1 : 0);

/**
 * A read that GitHub refuses while its feature is off (404, or 403 "must be
 * enabled", "not enabled", "is disabled") answers null; other failures throw.
 */
async function offWhenDisabled(read) {
  try {
    return await read();
  } catch (err) {
    if (err instanceof GhError && (err.status === 404 || /must be enabled|not enabled|is disabled/i.test(err.message))) return null;
    throw err;
  }
}

/** security_and_analysis, or a throw that the wrapper turns into the admin reason. */
export async function securityAndAnalysis(L) {
  const sa = (await L.repo()).security_and_analysis;
  if (!sa) throw new GhError("security_and_analysis is hidden from this token", { status: 403 });
  return sa;
}
