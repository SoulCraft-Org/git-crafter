// Which refs a ruleset reaches. Its own file, with no package behind it, so tools/apply_setup_rows.mjs runs without npm ci.
import { globRegex } from "../github/github-lock.mjs";

/** Whether a ruleset's ref conditions reach `ref`; `defaultRef` is the default branch's full ref. */
export function reaches(ruleset, ref, defaultRef) {
  const { include = [], exclude = [] } = ruleset.conditions?.ref_name ?? {};
  const hit = (p) => p === "~ALL" || (p === "~DEFAULT_BRANCH" ? ref === defaultRef : globRegex(p).test(ref));
  return include.some(hit) && !exclude.some(hit);
}
