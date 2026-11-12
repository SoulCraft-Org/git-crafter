// Constants and the small math every collector module shares: the org, the
// windows, how a metric is built, and how a failed read is told apart from zero.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { LAST_N } from "./workflows.mjs";

export const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

// The org's own settings: the one config/*.json that names an "org". Another
// org copies it under its own name; a public checkout has none, so the org
// comes from the environment and the site from CODE_OS_SITE_REPO.
export function findOrgConfig(root = ROOT) {
  const dir = join(root, "config");
  if (!existsSync(dir)) return null;
  const hit = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .find((f) => {
      try {
        return typeof JSON.parse(readFileSync(join(dir, f), "utf8")).org === "string";
      } catch {
        return false;
      }
    });
  return hit ? `config/${hit}` : null;
}
// Which org and site a run reads: CODE_OS_ORG, then the org config, then the
// repo's own owner in Actions (GITHUB_REPOSITORY_OWNER). The site repo:
// CODE_OS_SITE_REPO, then the config's site_repo, else none.
export function orgSettings(env = process.env, root = ROOT) {
  const path = findOrgConfig(root);
  const config = path ? JSON.parse(readFileSync(join(root, path), "utf8")) : {};
  return {
    config: path,
    org: env.CODE_OS_ORG || config.org || env.GITHUB_REPOSITORY_OWNER || null,
    site: env.CODE_OS_SITE_REPO || config.site_repo || null,
  };
}
const SETTINGS = orgSettings();
export const ORG_CONFIG = SETTINGS.config;
export const ORG = SETTINGS.org;
export const SITE_REPO = SETTINGS.site;
// The Quality page template's targets: a repo's own quality/targets hold only
// what differs, by id (quality/overlay.mjs), so a site metric's label and
// goal come from both.
export const TEMPLATE_TARGETS = resolve(ROOT, "quality", "targets");
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
// How far back each read goes; the values read the latest events within it.
export const PR_WEEKS = 6;
export const CI_WEEKS = 4;

// ---- Small math ---------------------------------------------------------

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const round = (v, d = 1) => (finite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

// `part` as a percent of `whole`, or null when `whole` is not positive.
export const share = (part, whole) => (whole > 0 ? (part / whole) * 100 : null);

// One metric, measured: headline value, optional per-repo values and a
// breakdown. Every number is rounded once, here.
export function measured(value, unit, source, readAt, extra = {}) {
  const out = { value: round(value, 2), unit, source, read_at: readAt };
  if (extra.by_repo) out.by_repo = Object.fromEntries(Object.entries(extra.by_repo).map(([r, v]) => [r, round(v, 2)]));
  if (extra.detail) out.detail = extra.detail.map((d) => ({ ...d, value: round(d.value, 2) }));
  // A value known only as a lower bound, for the org or a repo: the pages show it as "≥ x".
  if (extra.bound) out.bound = true;
  if (extra.bound_repos?.length) out.bound_repos = extra.bound_repos;
  return value === null || value === undefined || !finite(value) ? notMeasured(extra.reason ?? "nothing to measure in what was read", source) : out;
}
// A metric entry with no value, saying why and where it was read.
export const notMeasured = (reason, source) => ({ could_not_check: reason, source });

// A per-repo read is its rows, or null when that repo's read failed. A failed
// read is never zero: the repo's value is null and the org figure leaves it out.
export const mapRead = (repos, rowsByRepo, fn) => Object.fromEntries(repos.map((r) => [r, rowsByRepo[r] === null ? null : fn(rowsByRepo[r] ?? [], r)]));
// Every repo's rows in one list, skipping unread repos.
export const flat = (repos, rowsByRepo) => repos.flatMap((r) => rowsByRepo[r] ?? []);
// The latest LAST_N of rows, newest first, by timeOf; and the newest one.
export const lastN = (rows, timeOf) => [...rows].sort((a, b) => timeOf(b) - timeOf(a)).slice(0, LAST_N);
// The newest row by `timeOf`, or null when there are none.
export const newest = (rows, timeOf) => lastN(rows, timeOf)[0] ?? null;
// Every repo's rows in one list, each tagged with its repo.
export const tagRepo = (repos, rowsByRepo) => repos.flatMap((r) => (rowsByRepo[r] ?? []).map((x) => ({ ...x, repo: r })));

// A per-repo map of one statistic, plus the same statistic over the repos read.
export function perRepo(repos, rowsByRepo, stat) {
  const read = repos.filter((r) => rowsByRepo[r] !== null);
  const by = Object.fromEntries(repos.map((r) => [r, rowsByRepo[r] === null ? null : stat(rowsByRepo[r] ?? [])]));
  return { org: read.length ? stat(flat(read, rowsByRepo)) : null, by, unread: repos.filter((r) => rowsByRepo[r] === null) };
}
// What unread repos do to a metric: every repo unread, it carries the read
// error; a count or sum (total) with any repo unread is not measured and names
// them; a share or a latest value is measured over the repos read, its source
// naming the rest.
export function guard(unread, nRepos, failures, source, total) {
  if (!unread.length) return { source };
  const named = unread.map((r) => `${r} (${failures?.[r] ?? "read failed"})`).join("; ");
  if (unread.length === nRepos) return { fail: notMeasured(`could not read: ${named}`, source) };
  if (total) return { fail: notMeasured(`no org total, not read: ${named}`, source) };
  return { source: `${source}; not read: ${unread.join(", ")}` };
}
// A metric from one perRepo result under guard().
export function metric(p, nRepos, failures, total, value, unit, source, readAt, extra = {}) {
  const g = guard(p.unread, nRepos, failures, source, total);
  if (g.fail) return p.unread.length < nRepos ? { ...g.fail, by_repo: Object.fromEntries(Object.entries(p.by).map(([r, v]) => [r, round(v, 2)])) } : g.fail;
  return measured(value, unit, g.source, readAt, { by_repo: p.by, ...extra });
}

// True when the entry holds a finite value and no could_not_check.
export const isMeasured = (e) => Boolean(e) && e.could_not_check === undefined && finite(e.value);

// An error's first line of stderr or message, cut to 200 characters.
export const reasonOf = (err) => String(err.stderr || err.message || err).trim().split("\n")[0].slice(0, 200);
// Runs `fn`; on a throw, records the label and reason in `errors`.
export function attempt(label, fn, errors) {
  try {
    return fn();
  } catch (err) {
    errors.push(`${label}: ${reasonOf(err)}`);
    return undefined;
  }
}
