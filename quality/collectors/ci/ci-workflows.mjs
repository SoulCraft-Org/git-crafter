// How the CI collector reads a workflow file: its triggers, hooks, runners and the graph of its jobs.
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import YAML from "yaml";

// A repo file's text, or null when it is missing.
export const readText = (root, rel) => {
  const p = path.join(root, rel);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
};

// A workflow's on: as an object of event to settings, whatever form it was written in.
export function triggers(on) {
  if (typeof on === "string") return { [on]: null };
  if (Array.isArray(on)) return Object.fromEntries(on.map((k) => [k, null]));
  return on && typeof on === "object" ? on : {};
}

/**
 * Whether a workflow's `on` starts it for a pull request and for a push to
 * `branch`. Pass the repo's default branch; "main" stays the default only for
 * callers written before they read it.
 */
export function firesOn(on, branch = "main") {
  const t = triggers(on);
  return { pull_request: "pull_request" in t && changes(t.pull_request?.types), push: "push" in t && (!t.push?.branches || t.push.branches.includes(branch)) };
}

// The pull request activity types that bring new code or a new description; GitHub's defaults when a trigger names none.
const CHANGE_TYPES = ["opened", "synchronize", "reopened", "edited", "ready_for_review"];

// Whether a pull_request trigger's types include a change; one for closed or labeled pull requests runs on none.
function changes(types) {
  return !Array.isArray(types) || types.some((type) => CHANGE_TYPES.includes(type));
}

/** Whether the workflow file at `rel` still starts on a push to `branch`; false once the file is gone. */
export function runsOnPush(root, rel, branch) {
  const file = path.join(root, rel ?? "");
  if (!rel || !existsSync(file)) return false;
  return firesOn((YAML.parse(readFileSync(file, "utf8")) ?? {}).on, branch).push;
}

// A step's name, else "uses <action>" or "run".
export const stepName = (s) => s.name ?? (s.uses ? `uses ${s.uses.split("@")[0]}` : "run");

// Text cut to n characters with an ellipsis.
export const clip = (s, n = 320) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A shell script without its comment lines, so a comment never reads as code. */
const codeLines = (text) => text.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");

/**
 * A git hook's code lines, then those of each script it sources from its own
 * folder (`. path` or `source path`), so a hook that loads a shared router
 * reads as what the router runs. Comments never count: a hook that names a
 * check only in a comment does not run it.
 */
export function hookCode(root, dir, text) {
  const code = codeLines(text);
  const sourced = [...code.matchAll(/^\s*(?:\.|source)\s+["']?([^"'\s;]+)/gm)]
    .map((m) => readText(root, path.join(dir, path.basename(m[1]))))
    .filter((t) => t !== null)
    .map(codeLines);
  return [code, ...sourced].join("\n");
}

/**
 * What a git hook runs, in words, from its code (hookCode): a refused push to
 * `branch`, each `says` whose match is in the code, and the checks that the
 * global pattern `checks` names (its first matched group). The hook's name
 * when none of them is found.
 */
export function hookRuns(name, code, { branch, says = [], checks = null } = {}) {
  const parts = [];
  if (branch && code.includes(`refs/heads/${branch}`)) parts.push(`refuses a push to ${branch}`);
  for (const s of says) if (s.match.test(code)) parts.push(s.says);
  if (checks) {
    const found = new Set([...code.matchAll(checks)].map((m) => m.slice(1).find(Boolean)).filter(Boolean));
    if (found.size) parts.push(`checks ${[...found].join(", ")}`);
  }
  return clip(parts.join("; ") || name);
}

/** A reusable workflow's shard count: a number, or the default an expression falls back to. */
export function shardCount(value) {
  if (typeof value === "number") return value;
  const m = /^\s*(\d+)\s*$/.exec(String(value ?? "")) ?? /\|\|\s*'(\d+)'/.exec(String(value ?? ""));
  return m ? Number(m[1]) : null;
}

/** A runner in words: a label, a list of labels, or one picked by an expression at run time. */
export function runnerText(runsOn) {
  if (Array.isArray(runsOn)) return runsOn.join(", ");
  const s = String(runsOn ?? "");
  return !s || s.includes("${{") ? "a runner chosen at run time" : s;
}

/**
 * A job's names as GitHub shows them. A matrix of one key with plain values
 * expands into one name per value ("e2e: shard 1/2", "e2e: shard 2/2"); any
 * other matrix is counted ("tests … (1 of 4)").
 */
export function jobNames(id, job) {
  const name = String(job?.name ?? id);
  const matrix = job?.strategy?.matrix;
  if (!matrix || typeof matrix !== "object") return [name];
  const keys = Object.keys(matrix).filter((k) => k !== "include" && k !== "exclude");
  const values = keys.length === 1 ? matrix[keys[0]] : null;
  const slot = keys.length === 1 ? new RegExp(`\\$\\{\\{\\s*matrix\\.${keys[0]}\\s*\\}\\}`, "g") : null;
  if (Array.isArray(values) && values.every((v) => v === null || typeof v !== "object") && slot && name.match(slot)) {
    return values.map((v) => name.replace(slot, String(v)));
  }
  const n = keys.reduce((product, k) => product * (Array.isArray(matrix[k]) ? matrix[k].length : 1), 1);
  return Array.from({ length: n }, (_, i) => `${name.replace(/\$\{\{[^}]*\}\}/g, "…")} (${i + 1} of ${n})`);
}

/**
 * A workflow's jobs for one event, in the order they run: level 0 needs
 * nothing, and each later level needs only earlier ones. A job whose `if`
 * keeps it off this event (the Pages deploy on a pull request) is left out.
 */
export function jobGraph(jobs, event) {
  const off = event === "pull_request" ? /!=\s*'pull_request'/ : /==\s*'pull_request'/;
  const kept = jobs.filter(([, job]) => !off.test(String(job?.if ?? "")));
  const ids = new Set(kept.map(([id]) => id));
  const depth = new Map();
  const levelOf = (id, seen = new Set()) => {
    if (depth.has(id)) return depth.get(id);
    if (seen.has(id)) return 0; // a needs cycle, which GitHub rejects anyway
    seen.add(id);
    const needs = [kept.find(([k]) => k === id)?.[1]?.needs ?? []].flat().filter((n) => ids.has(n));
    const d = needs.length ? 1 + Math.max(...needs.map((n) => levelOf(n, seen))) : 0;
    depth.set(id, d);
    return d;
  };
  const levels = [];
  for (const [id, job] of kept) (levels[levelOf(id)] ??= []).push([id, job]);
  return levels.filter(Boolean);
}

/** One job in words: the reusable workflow it calls and its shards, or its runner. */
function jobText(id, job) {
  const names = jobNames(id, job);
  const who = names.length > 1 ? `${names.join(" and ")} in parallel` : names[0];
  const when = /outputs\./.test(String(job?.if ?? "")) ? ", if there is work" : "";
  if (job?.uses) {
    const shards = shardCount(job.with?.shards);
    return `${who} calls ${String(job.uses).split("@")[0]}${shards ? ` in ${shards} shard${shards === 1 ? "" : "s"}` : ""}${when}`;
  }
  return `${who} on ${runnerText(job?.["runs-on"])}${when}`;
}

/** A job graph in words: "a on x, then b and c in parallel on y, if there is work, then d on z". */
export function graphText(levels) {
  return levels.map((level) => level.map(([id, job]) => jobText(id, job)).join(" and ")).join(", then ");
}
