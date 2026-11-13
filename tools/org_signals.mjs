// The deploy, model, security and public-readiness metrics.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { flat, guard, lastN, mapRead, measured, metric, newest, notMeasured, ORG, ORG_CONFIG, perRepo, share } from "./org_base.mjs";
import { LAST_N } from "./workflows.mjs";

// ---- Deploys and models, from default-branch commits ----------------------

export const WORKERS_APP = "cloudflare-workers-and-pages";
const DEPLOY_FAIL = new Set(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED"]);

// commits: { repo: [{ oid, committedDate, message, deploys: [{ name, conclusion, completedAt }] }] }
// Only production counts as a deploy: a Workers Build named for staging is
// left out, so the metrics read could_not_check until production builds there.
export const STAGING = /staging/i;
// Production deploy metrics from each repo's commits and their deploy runs.
export function deployMetrics({ repos, commits, now, readAt, failures = {} }) {
  const outcome = (c) => {
    const runs = c.deploys.filter((d) => d.conclusion && !STAGING.test(d.name));
    if (!runs.length) return null;
    if (runs.some((d) => DEPLOY_FAIL.has(d.conclusion))) return { ok: false };
    if (!runs.every((d) => d.conclusion === "SUCCESS")) return null;
    const end = Math.max(...runs.map((d) => Date.parse(d.completedAt)));
    return { ok: true, minutes: (end - Date.parse(c.committedDate)) / 60_000 };
  };
  const at = (x) => x.at;
  const rows = mapRead(repos, commits, (list) => list.map((c) => ({ c, at: Date.parse(c.committedDate), o: outcome(c) })).filter((x) => x.o));
  // A share of each repo's last LAST_N production deploys; a time, the latest that succeeded.
  const last = mapRead(repos, rows, (list) => lastN(list, at));
  const deployed = repos.filter((r) => rows[r]?.length);
  const unread = repos.filter((r) => commits[r] === null);
  const src = `gh api graphql: default-branch history, check suites from the ${WORKERS_APP} app (Workers Builds check runs)`;
  const rate = (xs) => share(xs.filter((x) => x.o.ok).length, xs.length);
  const names = new Map();
  for (const r of deployed) for (const x of last[r]) for (const d of x.c.deploys.filter((d2) => !STAGING.test(d2.name))) names.set(`${r}: ${d.name}`, (names.get(`${r}: ${d.name}`) ?? 0) + 1);
  const reason = "no production Workers Builds check in the commits read; builds named for staging are left out";
  const ok = perRepo(deployed, last, rate);
  const mins = perRepo(deployed, rows, (xs) => newest(xs.filter((x) => x.o.ok), at)?.o.minutes ?? null);
  const g = guard(unread, repos.length, failures, `${src}; each repo's last ${LAST_N} production deploys`, false);
  const gm = guard(unread, repos.length, failures, `${src}; the latest production deploy that succeeded, commit time to its last Workers Builds check done`, false);
  return {
    "deploy.success_rate":
      g.fail ??
      measured(ok.org, "%", g.source, readAt, {
        by_repo: ok.by,
        detail: [...names].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value, unit: "builds" })),
        reason,
      }),
    "deploy.latest_minutes": gm.fail ?? measured(mins.org, "min", gm.source, readAt, { by_repo: mins.by, reason }),
  };
}

const TRAILER = /^co-authored-by:\s*(.+)$/gim;
const CLAUDE = /claude|anthropic/i;
export const THIRD_PARTY = /opencode|goose|qwen|deepseek|kimi|moonshot|glm|zhipu|llama|mistral|devstral|gemma|gpt|openai|codex|copilot|gemini|grok|minimax|openrouter|ollama/i;

// The AI co-authors a commit names: "claude" or the third-party name matched.
export function aiAuthors(message) {
  const names = [];
  for (const m of String(message ?? "").matchAll(TRAILER)) {
    const who = m[1].trim();
    if (CLAUDE.test(who)) names.push("claude");
    else if (THIRD_PARTY.test(who)) names.push(who.replace(/\s*<.*$/, "").toLowerCase());
  }
  return [...new Set(names)];
}

// Which AI models co-author each repo's recent commits, and the share not Claude.
export function modelMetrics({ repos, commits, now, readAt, failures = {} }) {
  // Each repo's last LAST_N commits that name an AI co-author.
  const tagged = mapRead(repos, commits, (list) => lastN(list.filter((c) => aiAuthors(c.message).length), (c) => Date.parse(c.committedDate)).map((c) => aiAuthors(c.message)));
  const third = (rows) => share(rows.filter((a) => a.some((who) => who !== "claude")).length, rows.length);
  const src = `gh api graphql: default-branch history (commit message Co-authored-by trailers), each repo's last ${LAST_N} commits with an AI co-author`;
  const counts = new Map();
  for (const a of flat(repos, tagged)) for (const who of a) counts.set(who, (counts.get(who) ?? 0) + 1);
  const t = perRepo(repos, tagged, third);
  return {
    "models.third_party_share": metric(t, repos.length, failures, false, t.org, "%", src, readAt, {
      detail: [...counts].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value, unit: "commits" })),
      reason: "no commit read names an AI co-author",
    }),
  };
}

// ---- Security --------------------------------------------------------------

// Open critical and high Dependabot alerts, per repo and per package.
export function alertMetrics({ repos, alerts, readAt, source = `gh api orgs/${ORG}/dependabot/alerts (state open, severity critical and high)` }) {
  const by = Object.fromEntries(repos.map((r) => [r, alerts.filter((a) => a.repo === r).length]));
  const pkgs = new Map();
  for (const a of alerts) pkgs.set(`${a.repo}: ${a.pkg} (${a.severity})`, (pkgs.get(`${a.repo}: ${a.pkg} (${a.severity})`) ?? 0) + 1);
  return {
    "security.critical_high_open": measured(alerts.length, "alerts", source, readAt, {
      by_repo: by,
      detail: [...pkgs].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value, unit: "alerts" })),
    }),
  };
}

// ---- Public readiness ---------------------------------------------------------

// Git Crafter goes public with its org settings kept apart (owner, 2026-11-03).
// The org config lists the names that belong to the org. Each one left in a
// tracked file outside config/ and data/, and each /Users/<name> path whose
// name starts with a letter and is not a placeholder, is one private reference.
// goals.json: goal 0.
export { ORG_CONFIG };
// Only the org's own folders are exempt: everything else ships in this public repo.
export const PUBLIC_EXEMPT = ["config/", "data/"];
export const HOME_PLACEHOLDERS = new Set(["someone", "Shared", "runner"]);
export const PUBLIC_SRC = `git ls-files outside ${PUBLIC_EXEMPT.join(" and ")}; names from ${ORG_CONFIG ?? "the org config"} private`;
const leaves = (v) => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(leaves) : []);
const literal = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// One pattern for every name: longest first, so a repo path wins over the user
// in it. A name inside a longer word or a domain (acme-site,
// acme.org) is a public name, not a match.
export function privatePattern(config) {
  const names = [...new Set(leaves(config?.private))].filter(Boolean).sort((a, b) => b.length - a.length);
  if (!names.length) return null;
  return new RegExp(`/Users/([A-Za-z][\\w-]*(?:\\.[\\w-]+)*)|(?<![\\w-])(?:${names.map(literal).join("|")})(?![\\w-]|\\.[a-z])`, "g");
}

// files: [{ path, text }], every tracked file. The breakdown names each file
// that still holds a reference, most first.
export function publicMetrics({ files, config, readAt }) {
  const re = privatePattern(config);
  if (!re) return { "public.private_refs": notMeasured(`${ORG_CONFIG ?? "the org config"} lists no private names`, PUBLIC_SRC) };
  const rows = files
    .filter((f) => !PUBLIC_EXEMPT.some((dir) => f.path.startsWith(dir)))
    .map((f) => ({ label: f.path, value: [...f.text.matchAll(re)].filter((m) => !HOME_PLACEHOLDERS.has(m[1])).length, unit: "refs" }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  const total = rows.reduce((s, r) => s + r.value, 0);
  return { "public.private_refs": measured(total, "refs", PUBLIC_SRC, readAt, { detail: rows }) };
}

// Every tracked text file in a checkout; a file with a NUL byte is binary and
// left out.
export function readTracked(root, exec = execFileSync) {
  return exec("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .map((path) => ({ path, text: readFileSync(join(root, path), "utf8") }))
    .filter((f) => !f.text.includes("\0"));
}
