// The Settings collector's reads, each run at most once per collect(), and the checks its metrics share.
import { GhError } from "../github/github-core.mjs";
import { once, readWorkflows } from "../github/github-loaders.mjs";
import { globRegex } from "../github/github-lock.mjs";
import { classicProtection } from "../github/github-reads.mjs";

// A workflow that hands every secret on, or reads one by a computed name: its files cannot show which secrets it uses.
const OPAQUE = /secrets:\s*inherit|secrets\s*\[|toJSON\(\s*secrets\s*\)/i;

/** Memoized reads of one repo's settings. */
export function reads({ gh, repo, root }) {
  const R = {
    repo: once(() => gh.rest(`repos/${repo}`)),
    branch: once(async () => (await R.repo()).default_branch),
    // Every active ruleset that reaches the repo, its own and its organization's, with its rules.
    rulesets: once(async () => {
      const list = await gh.restAll(`repos/${repo}/rulesets?includes_parents=true&targets=branch,tag,push&per_page=100`);
      return Promise.all(list.filter((s) => s.enforcement === "active").map((s) => gh.rest(`repos/${repo}/rulesets/${s.id}`)));
    }),
    classic: once(async () => classicProtection(gh, repo, await R.branch())),
    environments: once(async () => (await gh.rest(`repos/${repo}/environments?per_page=100`)).environments ?? []),
    firstTag: once(async () => (await gh.rest(`repos/${repo}/tags?per_page=1`))[0] ?? null),
    outside: once(() => gh.restAll(`repos/${repo}/collaborators?affiliation=outside&per_page=100`)),
    invitations: once(() => gh.restAll(`repos/${repo}/invitations?per_page=100`)),
    secretNames: once(() => secretNames(R, gh, repo)),
    cacheLimit: once(() => orNull(() => gh.rest(`repos/${repo}/actions/cache/storage-limit`))),
    forkApproval: once(() => orNull(() => gh.rest(`repos/${repo}/actions/permissions/fork-pr-contributor-approval`))),
    vulnReporting: once(() => orNull(() => gh.rest(`repos/${repo}/private-vulnerability-reporting`))),
    workflows: once(async () => readWorkflows(root) ?? []),
  };
  return R;
}

// The read's answer, or null when the repo has no such setting (HTTP 404).
async function orNull(read) {
  try {
    return await read();
  } catch (err) {
    if (err instanceof GhError && err.status === 404) return null;
    throw err;
  }
}

// The names of the repo's Actions secrets and of each environment's.
async function secretNames(R, gh, repo) {
  const own = (await gh.rest(`repos/${repo}/actions/secrets?per_page=100`)).secrets ?? [];
  const perEnv = await Promise.all((await R.environments()).map((e) => gh.rest(`repos/${repo}/environments/${encodeURIComponent(e.name)}/secrets?per_page=100`)));
  return [...own, ...perEnv.flatMap((p) => p.secrets ?? [])].map((s) => s.name);
}

/** Whether a ruleset's ref conditions reach `ref`; `defaultRef` is the default branch's full ref. */
export function reaches(ruleset, ref, defaultRef) {
  const { include = [], exclude = [] } = ruleset.conditions?.ref_name ?? {};
  const hit = (p) => p === "~ALL" || (p === "~DEFAULT_BRANCH" ? ref === defaultRef : globRegex(p).test(ref));
  return include.some(hit) && !exclude.some(hit);
}

/** The active branch rulesets that reach the default branch. */
export async function branchSets(R) {
  const ref = `refs/heads/${await R.branch()}`;
  return (await R.rulesets()).filter((s) => s.target === "branch" && reaches(s, ref, ref));
}

// Every rule of `type` in `sets`.
export const rulesOf = (sets, type) => sets.flatMap((s) => s.rules ?? []).filter((r) => r.type === type);

/** How many of `names` a workflow file reads, or null when a workflow hides which it reads. */
export function secretsRead(names, files) {
  if (files.some((f) => OPAQUE.test(f.text))) return null;
  // Expressions ignore case, so secrets.token and secrets.TOKEN are one secret.
  return names.filter((n) => files.some((f) => new RegExp(`\\bsecrets\\.${n}\\b`, "i").test(f.text))).length;
}
