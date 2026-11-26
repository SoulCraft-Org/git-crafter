// Org rules tab: active branch rulesets that cover every repo, and whether one
// guards the default branch with a pull request and no force push or deletion.
// A state read now: the org's branch rulesets, each read in full, one at a time.
// Org rulesets need GitHub Team or Enterprise; a plan or token without them is not measured.
import { levelReader, results, timing, why } from "../../../reader.mjs";

export const area = "org-rules";
export const scope = "org";

const SOURCE = "quality/levels/org/collectors/org-rules/org-rules.mjs";
const ID = {
  allRepos: "org_rules.all_repo_rulesets",
  guarded: "org_rules.default_branch_guarded",
  seconds: "org_rules.read_seconds",
  requests: "org_rules.requests",
};
export const metricIds = Object.values(ID);
const GUARD = ["pull_request", "non_fast_forward", "deletion"];

// A ruleset that targets every repo of the org.
export const onAllRepos = (rs) => (rs.conditions?.repository_name?.include ?? []).includes("~ALL");
// A ruleset on every repo that guards the default branch with each GUARD rule.
export const guardsDefault = (rs) => {
  const refs = rs.conditions?.ref_name?.include ?? [];
  const types = new Set((rs.rules ?? []).map((x) => x.type));
  return onAllRepos(rs) && (refs.includes("~DEFAULT_BRANCH") || refs.includes("~ALL")) && GUARD.every((t) => types.has(t));
};

export async function collect({ owner, params = {}, mode, lib, gh, env } = {}) {
  const r = results(metricIds, SOURCE);
  const org = String(params.owner || owner || "");
  if (!org) return r.all("no org to read: set owner in the quality config, or params.owner");
  const read = levelReader({ gh, lib, mode, env });
  const source = `state: gh api orgs/${org}/rulesets?targets=branch, then each active one in full`;
  try {
    const listed = await read.restAll(`orgs/${org}/rulesets?targets=branch&per_page=100`);
    const full = [];
    for (const rs of listed.filter((x) => x.enforcement === "active")) full.push(await read.rest(`orgs/${org}/rulesets/${rs.id}`));
    const wide = full.filter(onAllRepos);
    r.val(ID.allRepos, wide.length, `${source}; ${listed.length} branch rulesets`, wide.map((x) => ({ label: x.name, value: 1, unit: "ruleset" })));
    r.val(ID.guarded, full.some(guardsDefault) ? 1 : 0, `${source}: one on ~ALL repos, ~DEFAULT_BRANCH, with rules ${GUARD.join(", ")}`);
  } catch (err) {
    const reason = err?.status === 403 || err?.status === 404 ? "org rulesets need GitHub Team or Enterprise and an org admin's token" : why(err);
    r.cnc(ID.allRepos, reason, source);
    r.cnc(ID.guarded, reason, source);
  }
  timing(r, read, ID, `org ${org}`);
  return r.done();
}
