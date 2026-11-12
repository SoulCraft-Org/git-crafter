// The GitHub collector's params, checked and compiled; a wrong shape or a pattern that does not compile throws a ConfigError naming the param.
import { ConfigError, TARGETS_FILE } from "./github-core.mjs";
import { globRegex } from "./github-lock.mjs";

// The built-in workflows a board turns on (GitHub docs, Using the built-in
// automations): a new item gets Todo, an issue with a linked pull request gets
// In Progress, a closed item and a merged pull request get Done, and matching
// items are added on their own.
const PROJECT_WORKFLOWS = ["Item added to project", "Pull request linked to issue", "Item closed", "Pull request merged", "Auto-add to project"];

/**
 * The params this collector reads, checked and compiled. Throws a ConfigError
 * naming the param when one has the wrong shape or a pattern does not compile.
 */
export function settings(params, repo) {
  return { ...projectSettings(params, repo), ...reviewSettings(params), ...supplySettings(params) };
}

// params[key] (or fallback) as a number of 0 or more, else a ConfigError.
const number = (params, key, fallback) => {
  const v = params[key] ?? fallback;
  if (typeof v !== "number" || !(v >= 0)) throw new ConfigError(`params.${key} in ${TARGETS_FILE} must be a number of 0 or more`);
  return v;
};

// params[key] as a list of strings, empty when unset, else a ConfigError.
const list = (params, key) => {
  const v = params[key] ?? [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new ConfigError(`params.${key} in ${TARGETS_FILE} must be a list of strings`);
  return v;
};

/** The list at params[key], or `fallback` when the param is not set at all. */
const listOr = (params, key, fallback) => (params[key] === undefined ? fallback : list(params, key));

// params[key] as compiled regular expressions, else a ConfigError.
const patterns = (params, key, flags) =>
  list(params, key).map((src) => {
    try {
      return new RegExp(src, flags);
    } catch (err) {
      throw new ConfigError(`params.${key} in ${TARGETS_FILE}: ${err.message}`);
    }
  });

// The security review pattern as a check-name test and a comment-line test.
function reviewPatterns(src) {
  try {
    return { check: new RegExp(src, "i"), line: new RegExp(`^\\W*(?:claude\\s+)?(?:${src})`, "i") };
  } catch (err) {
    throw new ConfigError(`params.security_review in ${TARGETS_FILE}: ${err.message}`);
  }
}

// Parsed once, with a trailing slash, so a host or path is never matched as text.
function registries(srcs) {
  return srcs.map((src) => {
    const u = URL.canParse(src) ? new URL(src) : null;
    if (u?.protocol !== "https:" || u.username || u.password || u.search || u.hash) throw new ConfigError(`params.registries in ${TARGETS_FILE}: ${JSON.stringify(src)} is not a plain https URL`);
    if (!u.pathname.endsWith("/")) u.pathname += "/";
    return u;
  });
}

// The project params: bug label and type, area labels, issue types, project title, columns and workflows.
export function projectSettings(params, repo) {
  return {
    bugLabel: params.bug_label || "bug",
    bugType: params.bug_type || "Bug",
    areas: list(params, "area_labels"),
    projectTitle: params.project_title || repo?.split("/")[1] || "",
    columns: list(params, "project_columns"),
    workflows: listOr(params, "project_workflows", PROJECT_WORKFLOWS),
    // Words of prose a card may carry and still read at a glance.
    cardWords: number(params, "card_words", 75),
    siteUrl: params.site_url || "",
    notReviewed: patterns(params, "not_reviewed"),
    bodyIgnore: patterns(params, "pr_body_ignore", "g"),
    // Bug and Task are two of the three types GitHub gives every organization.
    issueTypes: listOr(params, "issue_types", ["Bug", "Task"]),
    parkHours: number(params, "park_hours", 24),
    recordMinutes: number(params, "record_minutes", 5),
  };
}

// The review params: review apps and authors, security review pattern and paths.
function reviewSettings(params) {
  return {
    reviewApps: listOr(params, "review_apps", ["claude"]),
    reviewAuthors: listOr(params, "review_authors", ["claude"]),
    securityReview: reviewPatterns(params.security_review || "security[- ]?review"),
    reviewPaths: list(params, "review_paths").map(globRegex),
  };
}

// The supply-chain params: cooldown, registries, credential patterns and threat model.
function supplySettings(params) {
  const given = params.threat_model ?? "";
  const threatModels = Array.isArray(given) ? given : [given || "THREAT-MODEL.md"];
  if (!threatModels.length || !threatModels.every((m) => typeof m === "string" && m)) throw new ConfigError(`params.threat_model in ${TARGETS_FILE} must be a path or a list of paths, as text`);
  return {
    cooldownDays: number(params, "cooldown_days", 14),
    registries: registries(listOr(params, "registries", ["https://registry.npmjs.org/"])),
    credentialPatterns: list(params, "credential_patterns"),
    threatModels,
    threatModelCovers: list(params, "threat_model_covers"),
    threatModelGraceDays: number(params, "threat_model_grace_days", 0),
    maxRegistryReads: number(params, "max_registry_reads", 100),
  };
}
