// The CI collector's params, checked and compiled, and the could_not_check text for an error.
import { ConfigError, GhError } from "../github/github.mjs";
import { RATE_LIMIT, TARGETS_FILE } from "./ci-core.mjs";

/** The could_not_check text for an error from a gh read. */
export function reasonFor(err) {
  if (err instanceof ConfigError) return err.message;
  if (err instanceof GhError) {
    if (err.status === 401) return "gh is not signed in: run gh auth login";
    if (RATE_LIMIT.test(err.message)) return "the GitHub API rate limit is spent; the next read after it resets will measure this";
    return `gh api failed${err.status ? ` (HTTP ${err.status})` : ""}: ${err.message}`;
  }
  return `${err?.name ?? "Error"}: ${err?.message ?? err}`;
}

/**
 * The params this collector reads (see the header), checked and compiled.
 * Throws a ConfigError naming the param when one has the wrong shape or a
 * pattern does not compile.
 */
export function settings(params) {
  const text = (key, fallback) => {
    const v = params[key] ?? fallback;
    if (typeof v !== "string") fail(key, "must be text");
    return v || fallback;
  };
  const pattern = (key, src, flags) => {
    try {
      return new RegExp(src, flags);
    } catch (err) {
      return fail(key, `has a pattern that does not compile: ${err.message}`);
    }
  };
  const says = listOf(params, "hook_says", (s) => typeof s?.match === "string" && typeof s?.says === "string", "must be a list of { match, says }");
  const stages = listOf(params, "stages", (s) => ["label", "stage", "kind", "runs", "file"].every((k) => typeof s?.[k] === "string"), "must be a list of { label, stage, kind, runs, file, key? }");
  const apps = listOf(params, "deploy_apps", (a) => typeof a === "string", "must be a list of GitHub App slugs");
  const checks = text("hook_checks", "");
  const scans = text("security_workflows", "codeql|secret|security|scan|dependency.review");
  return {
    branch: text("default_branch", "") || null,
    hooksDir: text("hooks_dir", ".githooks"),
    hookSays: says.map((s) => ({ match: pattern("hook_says", s.match), says: s.says })),
    hookChecks: checks ? pattern("hook_checks", checks, "g") : null,
    stages,
    deployApps: apps,
    securityWorkflows: pattern("security_workflows", scans, "i"),
  };
}

// Throws a ConfigError naming the param and what is wrong with it.
function fail(key, what) {
  throw new ConfigError(`params.${key} in ${TARGETS_FILE} ${what}`);
}

/** params[key] as a list whose every item passes `ok`; empty when unset. */
function listOf(params, key, ok, what) {
  const list = params[key] ?? [];
  if (!Array.isArray(list) || !list.every(ok)) fail(key, what);
  return list;
}
