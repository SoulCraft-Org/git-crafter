// Org security tab: two-factor authentication required, and a code security
// configuration set as the default for new repos. A state read now.
// Org: params.owner, else the config's owner. A token without owner rights
// leaves a metric not measured, never 0 (quality/collectors/README.md).
import { levelReader, results, timing, why } from "../../../reader.mjs";

export const area = "org-security";
export const scope = "org";

const SOURCE = "quality/levels/org/collectors/org-security/org-security.mjs";
const ID = {
  twoFactor: "org_security.two_factor_required",
  config: "org_security.new_repo_security_config",
  seconds: "org_security.read_seconds",
  requests: "org_security.requests",
};
export const metricIds = Object.values(ID);

// True when the defaults cover both public and private repos.
export const coversAll = (defaults) => {
  const scopes = new Set(defaults.map((d) => d.default_for_new_repos));
  return scopes.has("all") || (scopes.has("public") && scopes.has("private_and_internal"));
};

// Two-factor required: 1 or 0, or not measured when the token cannot see it.
function twoFactor(r, o, org) {
  const src = `state: gh api orgs/${org}: two_factor_requirement_enabled`;
  if (typeof o.two_factor_requirement_enabled === "boolean") r.val(ID.twoFactor, o.two_factor_requirement_enabled ? 1 : 0, src);
  else r.cnc(ID.twoFactor, "this token sees no two_factor_requirement_enabled: it needs an org owner's token with admin:org", src);
}

// A default code security configuration for new public and private repos.
async function securityConfig(r, read, org) {
  const src = `state: gh api orgs/${org}/code-security/configurations/defaults: default_for_new_repos covers public and private repos`;
  try {
    const defaults = await read.rest(`orgs/${org}/code-security/configurations/defaults`);
    const list = Array.isArray(defaults) ? defaults : [];
    r.val(ID.config, coversAll(list) ? 1 : 0, src, list.map((d) => ({ label: `default for ${d.default_for_new_repos}`, value: 1, unit: "configuration" })));
  } catch (err) {
    r.cnc(ID.config, [403, 404].includes(err?.status) ? "needs an org owner's or security manager's token with read:org" : why(err), src);
  }
}

// Every Org security metric for one org, keyed by id.
export async function collect({ owner, params = {}, mode, lib, gh, env } = {}) {
  const r = results(metricIds, SOURCE);
  const org = String(params.owner || owner || "");
  if (!org) return r.all("no org to read: set owner in the quality config, or params.owner");
  const read = levelReader({ gh, lib, mode, env });
  let failed;
  const o = await read.rest(`orgs/${org}`).catch((err) => (failed = err));
  if (failed) return r.all(`gh api orgs/${org}: ${why(failed)}`);
  twoFactor(r, o, org);
  await securityConfig(r, read, org);
  timing(r, read, ID, `org ${org}`);
  return r.done();
}
