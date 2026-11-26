// Org members tab: members without two-factor authentication, and the base
// permission every member gets on every repo. A state read now.
// Privacy: counts only, never a member's login.
// The 2FA filter is for org owners only; another token leaves it not measured, never 0.
import { levelReader, results, timing, why } from "../../../reader.mjs";

export const area = "org-members";
export const scope = "org";

const SOURCE = "quality/levels/org/collectors/org-members/org-members.mjs";
const ID = {
  no2fa: "org_members.without_2fa",
  base: "org_members.base_permission_least",
  seconds: "org_members.read_seconds",
  requests: "org_members.requests",
};
export const metricIds = Object.values(ID);
const LEAST = new Set(["none", "read"]);

// Every Org members metric for one org, keyed by id.
export async function collect({ owner, params = {}, mode, lib, gh, env } = {}) {
  const r = results(metricIds, SOURCE);
  const org = String(params.owner || owner || "");
  if (!org) return r.all("no org to read: set owner in the quality config, or params.owner");
  const read = levelReader({ gh, lib, mode, env });

  const tfSource = `state: gh api orgs/${org}/members?filter=2fa_disabled, every page; a count`;
  try {
    const off = await read.restAll(`orgs/${org}/members?filter=2fa_disabled&per_page=100`);
    r.val(ID.no2fa, off.length, tfSource);
  } catch (err) {
    const owners = [403, 404, 422].includes(err?.status);
    r.cnc(ID.no2fa, owners ? "the 2fa_disabled filter answers org owners only" : why(err), tfSource);
  }

  const baseSource = `state: gh api orgs/${org}: default_repository_permission is none or read`;
  try {
    const o = await read.rest(`orgs/${org}`);
    const perm = o.default_repository_permission;
    if (typeof perm === "string") r.val(ID.base, LEAST.has(perm) ? 1 : 0, baseSource, [{ label: perm, value: 1, unit: "base permission" }]);
    else r.cnc(ID.base, "this token sees no default_repository_permission: it needs an org owner's token with admin:org", baseSource);
  } catch (err) {
    r.cnc(ID.base, `gh api orgs/${org}: ${why(err)}`, baseSource);
  }

  timing(r, read, ID, `org ${org}`);
  return r.done();
}
