// Email privacy tab: the primary email kept private, and no personal email in
// the account's latest 100 public commits. "Block command line pushes that
// expose my email" has no REST field; the commit count shows its effect.
// Privacy: an address is counted, never kept or printed.
import { levelReader, results, timing, why } from "../../../reader.mjs";

export const area = "email-privacy";
export const scope = "user";

const SOURCE = "quality/levels/user/collectors/email-privacy/email-privacy.mjs";
const ID = {
  primary: "email_privacy.primary_private",
  commits: "email_privacy.personal_commit_emails",
  seconds: "email_privacy.read_seconds",
  requests: "email_privacy.requests",
};
export const metricIds = Object.values(ID);
const NOREPLY = /(@users\.noreply\.github\.com|^noreply@github\.com)$/i;

// An author email that is not GitHub's noreply.
export const personal = (email) => {
  const e = String(email ?? "").trim();
  return Boolean(e) && !NOREPLY.test(e);
};

// The primary address kept private: 1 or 0, or not measured for another login or a token without user:email.
async function primaryPrivate(r, read, self) {
  const src = "state: gh api user/emails: visibility of the primary address";
  if (!self) return r.cnc(ID.primary, "GitHub shows a user's emails to the account itself only: sign gh in as that user", src);
  try {
    const primary = (await read.restAll("user/emails?per_page=100")).find((e) => e.primary);
    if (primary) r.val(ID.primary, primary.visibility === "private" ? 1 : 0, src);
    else r.cnc(ID.primary, "gh api user/emails listed no primary address", src);
  } catch (err) {
    const scope = err?.status === 403 || err?.status === 404;
    r.cnc(ID.primary, scope ? "the token lacks the user:email scope: gh auth refresh -s user:email" : why(err), src);
  }
}

// Distinct personal author emails in the login's latest 100 public commits.
async function commitEmails(r, read, login) {
  const src = `last 100 events: gh api search/commits?q=author:${login}, newest first; distinct author emails other than GitHub noreply, a count`;
  try {
    const found = await read.rest(`search/commits?q=${encodeURIComponent(`author:${login}`)}&sort=author-date&order=desc&per_page=100`);
    const items = found.items ?? [];
    const seen = new Set(items.map((c) => c.commit?.author?.email).filter(personal).map((e) => e.toLowerCase()));
    r.val(ID.commits, seen.size, `${src}; ${items.length} commits`);
  } catch (err) {
    r.cnc(ID.commits, why(err), src);
  }
}

// Every Email privacy metric for one login, keyed by id.
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
  await primaryPrivate(r, read, login.toLowerCase() === String(me.login).toLowerCase());
  await commitEmails(r, read, login);
  timing(r, read, ID, `user ${login}`);
  return r.done();
}
