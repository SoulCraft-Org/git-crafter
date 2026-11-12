// Live usage for the Systems tab, read-only: every read systems.json lists,
// each by its reader kind (GitHub's rate limits, an entry of the Quality data,
// a minute guard's CI notice, Comfy Cloud's credit balance, an app's session
// folder on this Mac account). collect_org.mjs calls systemsMetrics() once.
// A read that fails is could_not_check with its reason, never 0. Nothing here
// reads a credential file or prints a token (~/.claude/rules/keys.md): the
// app reader opens only session folders.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DAY = 86_400_000;
const notMeasured = (reason, source) => ({ could_not_check: reason, source });
const reasonOf = (err) => String(err?.stderr || err?.message || err).trim().split("\n")[0].slice(0, 200);

/** Used = limit less remaining, from one rate_limit resource. */
export function rateUse(resource, label, readAt) {
  if (!resource || typeof resource.limit !== "number" || typeof resource.remaining !== "number") return notMeasured("rate_limit had no such resource", "gh api rate_limit");
  return {
    label,
    value: resource.limit - resource.remaining,
    unit: label.startsWith("GraphQL") ? "points" : "requests",
    detail: [
      { label: "limit the API reports", value: resource.limit, unit: "" },
      { label: "remaining", value: resource.remaining, unit: "" },
    ],
    source: `gh api rate_limit (does not count against the limit), resets ${new Date(resource.reset * 1000).toISOString().slice(11, 16)} UTC`,
    read_at: readAt,
  };
}

/** Minutes from a guard's notice: "Blacksmith: 1587 of this repository's 1800 minutes in the last 31 days". */
export function guardMinutes(messages) {
  for (const m of messages ?? []) {
    const hit = /Blacksmith:\s*(\d+(?:\.\d+)?)\s+of this repository's\s+(\d+)\s+minutes/i.exec(String(m));
    if (hit) return { minutes: Number(hit[1]), share: Number(hit[2]) };
  }
  return null;
}

/** Plan credits used this cycle from comfy cloud status's JSON, or null when it cannot say. */
export function comfyUsed(status, planCredits) {
  const d = status?.data;
  if (!status?.ok || typeof d?.credit_balance_credits !== "number" || !d.balance_confirmed) return null;
  return { used: Math.max(planCredits - d.credit_balance_credits, 0), balance: d.credit_balance_credits, tier: d.subscription?.tier ?? "", renews: d.subscription?.renewal_date ?? "" };
}

// A session file's provider name, read from its first 8 KB.
const providerIn = (path, providerOf) => providerOf(readFileSync(path, "utf8").slice(0, 8192)) ?? "unknown";

// A session file: a .json or .jsonl, touched in the last 14 days.
const isSession = (name, st, now) => st.isFile() && /\.jsonl?$/.test(name) && now - st.mtimeMs <= 14 * DAY;

// Session files under one folder, newest first, read for their provider
// names only; files over 14 days old are left out.
export function countSessions(dir, providerOf, now = Date.now(), maxFiles = 2000) {
  if (!existsSync(dir)) return { sessions: 0, providers: {}, folder: false };
  const providers = {};
  let sessions = 0;
  const walk = (d, depth) => {
    for (const name of readdirSync(d)) {
      if (/auth|key|token|secret|credential/i.test(name)) continue;
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (isSession(name, st, now) && sessions < maxFiles) {
        sessions += 1;
        const who = providerIn(p, providerOf);
        providers[who] = (providers[who] ?? 0) + 1;
      }
    }
  };
  walk(dir, 0);
  return { sessions, providers, folder: true };
}
const PROVIDER = /"(?:provider|provider_name|providerID)"\s*:\s*"([\w.-]+)"/;
const providerOf = (head) => PROVIDER.exec(head)?.[1] ?? null;

function sessionMetric(app, dir, readAt, home) {
  try {
    const c = countSessions(dir, providerOf);
    const where = dir.replace(home, "~");
    return {
      label: `${app} sessions, 14 days`,
      value: c.sessions,
      unit: "sessions",
      detail: Object.entries(c.providers).map(([label, value]) => ({ label, value, unit: "sessions" })),
      source: c.folder ? `${where}: session files, by provider` : `${where}: no session folder, so this Mac account has run no ${app} session`,
      read_at: readAt,
    };
  } catch (err) {
    return notMeasured(`could not read ${app}'s session folder: ${reasonOf(err)}`, dir.replace(home, "~"));
  }
}

// Why a Quality entry is not a number: the data could not be read, or it has no such entry.
const qualityMissing = (e, r, ctx) => (ctx.site ? (e?.could_not_check ?? `the Quality data has no ${r.id} entry`) : "could not read the Quality data");

// One reader per kind systems.json names. Each takes the read's params and
// the shared context, and returns a metric entry; a failure is could_not_check.
const READERS = {
  rate_limit(r, ctx) {
    ctx.rateLimit ??= (() => {
      try {
        return { resources: ctx.gh.rest("rate_limit", ".resources") };
      } catch (err) {
        return { error: reasonOf(err) };
      }
    })();
    const rl = ctx.rateLimit;
    return rl.error ? notMeasured(`could not read rate_limit: ${rl.error}`, "gh api rate_limit") : rateUse(rl.resources[r.resource], r.label, ctx.readAt);
  },

  // An entry of the Quality data the collector fetched; row picks one detail
  // row by its label instead of the entry's own value.
  quality_metric(r, ctx) {
    const e = ctx.site?.data?.metrics?.[r.id];
    const src = `${ctx.siteSource} ${r.id}`;
    if (!e || typeof e.value !== "number") return notMeasured(qualityMissing(e, r, ctx), src);
    const pick = r.row ? (e.detail ?? []).find((d) => new RegExp(r.row, "i").test(d.label)) : e;
    if (!pick) return notMeasured(`${r.id} has no "${r.row}" row`, src);
    return { label: r.label, value: pick.value, unit: r.unit ?? e.unit, ...(r.row ? { detail: e.detail } : {}), source: `${src}: ${e.source ?? ""}`, read_at: e.read_at };
  },

  // Each guard's own reading: its newest run's job writes the notice. Three
  // REST calls a guarded repo; a guard with no workflow publishes nothing.
  guard_notice(r, ctx) {
    const byRepo = {};
    const unread = [];
    for (const g of r.guards ?? []) {
      if (!g.workflow) {
        byRepo[g.repo] = null;
        unread.push(`${g.repo} (no guard publishes a reading)`);
        continue;
      }
      try {
        const run = ctx.gh.rest(`repos/${ctx.org}/${g.repo}/actions/workflows/${g.workflow}/runs?per_page=1&status=completed`, ".workflow_runs[0].id");
        const jobs = ctx.gh.rest(`repos/${ctx.org}/${g.repo}/actions/runs/${run}/jobs?per_page=100`, "[.jobs[] | {id, name}]");
        const job = jobs.find((j) => new RegExp(g.job, "i").test(j.name));
        const notes = job ? ctx.gh.rest(`repos/${ctx.org}/${g.repo}/check-runs/${job.id}/annotations`, "[.[].message]") : [];
        const read = guardMinutes(notes);
        byRepo[g.repo] = read ? read.minutes : null;
        if (!read) unread.push(`${g.repo} (its newest run wrote no notice)`);
      } catch (err) {
        byRepo[g.repo] = null;
        unread.push(`${g.repo} (${reasonOf(err)})`);
      }
    }
    const src = "each guard's notice in its newest CI run (gh api check-runs annotations)";
    const detail = (r.guards ?? []).map((g) => ({ label: `${g.repo}, share ${g.share}`, value: byRepo[g.repo], unit: "minutes" })).filter((d) => typeof d.value === "number");
    return unread.length
      ? { ...notMeasured(`no org total, not read: ${unread.join("; ")}`, src), by_repo: byRepo, detail }
      : { label: r.label, value: Object.values(byRepo).reduce((a, b) => a + b, 0), unit: "minutes", by_repo: byRepo, detail, source: src, read_at: ctx.readAt };
  },

  // comfy cloud status is read-only and spends nothing; the plan's credits are
  // the system's first limit.
  comfy_status(r, ctx, x) {
    const plan = x.limits?.[0]?.value;
    try {
      const status = JSON.parse(ctx.exec("comfy", ["cloud", "status"], { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] }));
      const c = comfyUsed(status, plan);
      return c
        ? { label: r.label, value: c.used, unit: "credits", detail: [{ label: "balance", value: c.balance, unit: "credits" }], source: `comfy cloud status (read-only): ${c.tier} plan's ${plan} credits less the balance; renews ${c.renews.slice(0, 10)}`, read_at: ctx.readAt }
        : notMeasured("comfy cloud status gave no confirmed balance", "comfy cloud status");
    } catch (err) {
      return notMeasured(`could not run comfy cloud status: ${reasonOf(err)}`, "comfy cloud status");
    }
  },

  app_sessions(r, ctx) {
    return sessionMetric(r.app, r.dir.replace(/^~(?=\/|$)/, ctx.home), ctx.readAt, ctx.home);
  },
};

export const READER_KINDS = Object.keys(READERS);

/**
 * Every metric systems.json's reads name. gh: collect_org's client; site: its
 * fetched Quality data (or null), named by siteSource; doc: systems.json;
 * org: the GitHub org.
 */
// kinds: the reader kinds to run, or null for every one. A repo's own run
// passes REPO_READERS: the others read other repos, this Mac's comfy and its
// session folders, which on a CI runner would record a false 0.
export const REPO_READERS = ["rate_limit", "quality_metric"];
// Runs every reader systems.json names (or only `kinds`) and returns their metrics.
export function systemsMetrics({ gh, site, siteSource = "the Quality data", doc, org, readAt, home = homedir(), exec = execFileSync, kinds = null }) {
  const ctx = { gh, site, siteSource, org, readAt, home, exec };
  const out = {};
  for (const x of doc.systems) {
    for (const r of x.reads ?? []) {
      if (kinds && !kinds.includes(r.kind)) continue;
      const read = READERS[r.kind];
      out[r.metric] = read ? read(r, ctx, x) : notMeasured(`systems.json names no reader "${r.kind}"`, "systems.json");
    }
  }
  return out;
}
