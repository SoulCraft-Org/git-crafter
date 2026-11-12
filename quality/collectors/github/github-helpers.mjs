// What the GitHub metrics share: the could_not_check reasons, the project and card reads, workflow trigger checks, feature costs and alert lists.
import { skip, TARGETS_FILE, count, measured, ConfigError, RegistryError, GhError, NEEDS, LOCAL_REFRESH } from "./github-core.mjs";
import { LAST_CARDS } from "./github-queries.mjs";

// What each paid security feature costs on a private repo, from GitHub's own
// pages (read 2026-11-03; Code Quality's price 2026-11-10). On a public repo GitHub offers code scanning and
// secret scanning free (github.com/security/plans).
export const PAID = {
  code_security: { price: 30, text: "GitHub Code Security, $30 per active committer a month (github.com/security/plans, read 2026-11-03)" },
  secret_protection: { price: 19, text: "GitHub Secret Protection, $19 per active committer a month (github.com/security/plans, read 2026-11-03)" },
  code_quality: { price: 10, text: "GitHub Code Quality, $10 per active committer a month plus the Actions minutes its scans use (GitHub changelog, 2026-06-16, read 2026-11-10)" },
};

// An outside action or workflow: not this repo's own ./ or $/ copy, and not a docker:// image.
const isOutside = (uses) => typeof uses === "string" && !/^(\.\/|\$\/|docker:\/\/)/.test(uses);

/**
 * Every outside `uses:` target of a parsed workflow's steps: the actions a
 * lockfile covers. Read from the YAML, not its lines, so a uses: inside a
 * run: script or a block of fixture text is never counted.
 */
export function stepTargets(doc) {
  const jobs = Object.values(doc?.jobs ?? {}).filter((job) => job && typeof job === "object");
  return jobs.flatMap((job) => (Array.isArray(job.steps) ? job.steps : []).map((s) => s?.uses).filter(isOutside)).map((uses) => uses.trim());
}

/**
 * Every outside `uses:` target in a parsed workflow: each job's reusable
 * workflow and each step's action, local ./ and $/ and docker:// left out.
 */
export function usesTargets(doc) {
  const jobs = Object.values(doc?.jobs ?? {}).filter((job) => job && typeof job === "object");
  const calls = jobs.map((job) => job.uses).filter(isOutside).map((uses) => uses.trim());
  return [...calls, ...stepTargets(doc)];
}

/**
 * Project items with the board's in-progress and done columns, or a skip when
 * the columns are not set or the owner has no board by that title yet.
 */
export async function projectOr(L, cfg) {
  if (cfg.columns.length < 2) return skip(`params.project_columns in ${TARGETS_FILE} needs at least two columns: the last is done, the one before it in progress`);
  const items = await L.project();
  if (!items) return skip(`no project named ${cfg.projectTitle} yet; set params.project_title in ${TARGETS_FILE}`);
  return { items, doing: cfg.columns.at(-2), done: cfg.columns.at(-1) };
}

/**
 * The LAST_CARDS newest issues, newest first: [{ body, createdAt, number }].
 * Issues only, in every mode: a draft card becomes an issue when its pull
 * request opens, and projects.cards_at_a_glance reads the board's drafts.
 */
export async function cardsOr(L) {
  const issues = (await L.recentIssues()).map((i) => ({ body: i.body ?? "", createdAt: i.createdAt, number: i.number }));
  return issues.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, LAST_CARDS);
}

// Triggers that run with the base repo's secrets and write token, whatever
// the pull request holds (GitHub docs, Security hardening for GitHub Actions).
const PRIVILEGED_TRIGGERS = new Set(["pull_request_target", "workflow_run"]);

// The pull request's code: its head ref or sha, its head repo, or refs/pull/*.
const HEAD_CODE = /github\.event\.pull_request\.head|github\.head_ref|github\.event\.workflow_run\.head_(sha|branch|repository)|refs\/pull\//;

const RUN_CHECKOUT = /\bgh\s+pr\s+checkout\b|\bgit\s+(fetch|checkout|switch|pull)\b[^\n]*(refs\/pull\/|pull\/[^\s/]+\/(head|merge))/;

/** Whether a step brings the pull request's code into the job. */
export function runsPullRequestCode(step) {
  if (String(step?.uses ?? "").startsWith("actions/checkout")) return HEAD_CODE.test(`${step?.with?.ref ?? ""} ${step?.with?.repository ?? ""}`);
  return RUN_CHECKOUT.test(String(step?.run ?? ""));
}

/** Whether a workflow runs on a trigger that carries the base repo's secrets. */
function hasPrivilegedTrigger(doc) {
  const on = doc.on ?? doc[true];
  const triggers = typeof on === "string" ? [on] : Array.isArray(on) ? on : Object.keys(on ?? {});
  return triggers.some((t) => PRIVILEGED_TRIGGERS.has(t));
}

/** One count per job of a privileged workflow that checks out the pull request's code. */
export function prtJobs(f) {
  if (!hasPrivilegedTrigger(f.doc)) return [];
  return Object.entries(f.doc.jobs ?? {})
    .filter(([, job]) => (job?.steps ?? []).some(runsPullRequestCode))
    .map(([id]) => count(`${f.file}: job ${id}`, 1));
}

/** Workflow files, or a skip when the folder is missing. */
export async function workflowsOr(L) {
  return (await L.workflowFiles()) ?? skip("no .github/workflows folder under root");
}

/** A feature that is off says what turning it on costs: a price on a private repo, free on a public one. */
async function costNote(L, product) {
  const repo = await L.repo();
  const paid = PAID[product];
  if (repo.private === false && product !== "code_quality") return [count("free on a public repo: turn it on in the repo's settings", 0)];
  return [{ label: `paid on a private repo: ${paid.text}`, value: paid.price ?? 0, unit: paid.price ? "dollars per active committer a month" : "" }];
}

/** A feature's value, 1 or 0, with what turning it on costs when it is off. */
export async function feature(L, isOn, product, detail = []) {
  return measured(isOn ? 1 : 0, isOn || !product ? (detail.length ? detail : undefined) : [...detail, ...(await costNote(L, product))]);
}

/** Open alerts or findings while the feature is on; a skip naming the feature when it is off. */
export async function whileOn(isOn, featureName, read) {
  if (!isOn) return skip(`${featureName} is off, so it has no findings to count`);
  return read();
}

/** Each alert type that is readable now: Dependabot always, the others while their feature is on. */
async function alertSources(L) {
  const sources = [["Dependabot", await L.alerts()]];
  if (await L.codeScanningOn()) sources.push(["code scanning", await L.codeScanningAlerts()]);
  if ((await L.secretScanningOn()).secret) sources.push(["secret scanning", await L.secretScanningAlerts()]);
  return sources;
}

/** Every fixed alert across the readable types, newest fix first: { kind, createdAt, fixedAt }. */
export async function fixedAlerts(L) {
  const fixed = [];
  for (const [kind, alerts] of await alertSources(L)) {
    for (const a of alerts) {
      const at = kind === "secret scanning" ? (a.state === "resolved" && a.resolution === "revoked" ? a.resolved_at : null) : a.state === "fixed" ? a.fixed_at : null;
      if (at && a.created_at) fixed.push({ kind, createdAt: a.created_at, fixedAt: at });
    }
  }
  return fixed.sort((a, b) => Date.parse(b.fixedAt) - Date.parse(a.fixedAt));
}

/** Every open alert or finding across the readable types: { kind, createdAt }. */
export async function openAlerts(L) {
  const open = [];
  for (const [kind, alerts] of await alertSources(L)) for (const a of alerts) if (a.state === "open" && a.created_at) open.push({ kind, createdAt: a.created_at });
  for (const f of (await L.codeQualityOpen()) ?? []) if (f.created_at) open.push({ kind: "code quality", createdAt: f.created_at });
  return open;
}

/** The could_not_check text for an error, naming the fix where there is one. */
export function reasonFor(err, needs, mode) {
  if (err instanceof ConfigError || err instanceof RegistryError) return err.message;
  if (err instanceof GhError) return ghReason(err, needs, mode);
  return `${err?.name ?? "Error"}: ${err?.message ?? err}`;
}

// The permissions a workflow's token may lack; each has its own reason in NEEDS.
const TOKEN_NEEDS = ["github-admin", "vulnerability-alerts"];

/** Whether GitHub refused the read: forbidden, or a token an integration cannot raise. */
function denied(err) {
  return err.status === 403 || /not accessible by integration/i.test(err.message);
}

// The could_not_check reason for a gh error: sign-in, scope, admin or the API's own message.
function ghReason(err, needs, mode) {
  if (err.type === "INSUFFICIENT_SCOPES" && needs === "project-scope") return NEEDS["project-scope"];
  if (err.status === 401) return "gh is not signed in: run gh auth login";
  if (TOKEN_NEEDS.includes(needs) && denied(err)) return NEEDS[needs];
  if (mode === "ci" && /not accessible by integration/i.test(err.message)) return `${err.message}; ${LOCAL_REFRESH}`;
  return `gh api failed${err.status ? ` (HTTP ${err.status})` : ""}: ${err.message}`;
}
