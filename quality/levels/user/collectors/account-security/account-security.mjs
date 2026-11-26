// Account security tab: two-factor authentication on, and a commit signing key
// on the account. A state read now. GitHub returns two_factor_authentication to
// the account itself only, so a page for another login leaves it not measured.
// Vigilant mode has no REST field, so no metric reads it (quality/levels/README.md).
import { levelReader, results, timing, why } from "../../../reader.mjs";

export const area = "account-security";
export const scope = "user";

const SOURCE = "quality/levels/user/collectors/account-security/account-security.mjs";
const ID = {
  twoFactor: "account_security.two_factor_on",
  keys: "account_security.signing_keys",
  seconds: "account_security.read_seconds",
  requests: "account_security.requests",
};
export const metricIds = Object.values(ID);

export async function collect({ owner, params = {}, mode, lib, gh, env } = {}) {
  const r = results(metricIds, SOURCE);
  const read = levelReader({ gh, lib, mode, env });
  let me;
  try {
    me = await read.rest("user");
  } catch (err) {
    return r.all(`gh api user: ${why(err)}`);
  }
  const login = String(params.owner || owner || me.login || "");
  if (!login) return r.all("gh api user answered with no login");

  const tfSource = "state: gh api user: two_factor_authentication";
  if (login.toLowerCase() !== String(me.login).toLowerCase()) r.cnc(ID.twoFactor, "GitHub shows two_factor_authentication to the account itself only: sign gh in as that user", tfSource);
  else if (typeof me.two_factor_authentication === "boolean") r.val(ID.twoFactor, me.two_factor_authentication ? 1 : 0, tfSource);
  else r.cnc(ID.twoFactor, "gh api user answered without two_factor_authentication: the token is not the user's own", tfSource);

  const keySource = `state: gh api users/${login}/gpg_keys and users/${login}/ssh_signing_keys`;
  try {
    const gpg = await read.restAll(`users/${login}/gpg_keys?per_page=100`);
    const ssh = await read.restAll(`users/${login}/ssh_signing_keys?per_page=100`);
    r.val(ID.keys, gpg.length + ssh.length, keySource, [{ label: "GPG keys", value: gpg.length, unit: "keys" }, { label: "SSH signing keys", value: ssh.length, unit: "keys" }]);
  } catch (err) {
    r.cnc(ID.keys, why(err), keySource);
  }

  timing(r, read, ID, `user ${login}`);
  return r.done();
}
