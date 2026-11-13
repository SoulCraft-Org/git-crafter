// A repo's Quality page settings, read from its config file. Git Crafter holds
// the engine, the collectors and the template's targets; a repo holds only
// this file and what it measures that the template does not. Every key is
// optional and every path is relative to the repo root.
//
//   repo        "owner/name" for the page's links (issues, commits, review
//               files). Default: GITHUB_REPOSITORY, else no links
//   name        the page title's name. Default: the repo's name
//   tabs        the tab ids to show, in order. Default: the template's tabs
//               (score.mjs TABS) less the web tabs. An entry [id, name] adds a
//               tab of the repo's own
//   web         true shows the web tabs (Design, Usability) in the default list
//   targets     the repo's targets folder, laid over the template's by id
//               (score.mjs overlayTargets)
//   collectors  the repo's own collectors, run beside the template's
//   ideals      the repo's ideal states, one file per tab, in place of the
//               template's for the same tab (score.mjs loadIdeals)
//   packs       folders of tabs and maps from other repos, each
//               "owner/repo@<40-hex sha>", or a path in a --local run
//               (packs.mjs). Their tabs join the default list
//   reviews     review files (score.mjs loadAllReviews)
//   data        where collect.mjs writes latest.json and local.json
//   history     where a local run keeps one file a day
//   out         where build.mjs writes index.html
//   tokens_css  the color tokens the page draws with. Default: the
//               template's (render/tokens.css)
//   budget      the page's size budget in bytes
//   issue_sync  null (off) or { label, labels, project, quick, waiting }:
//               sync-issues.mjs makes a draft card on the owner's org
//               project number `project` per missed metric, Status Waiting
//               on data for ids in waiting, else Todo; ids in quick, or
//               every id with no project, open an issue with label, or
//               labels[tab] for its tab
//
// An unknown key is a usage error, so a typo never silently does nothing.

import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolvePacks } from "./packs.mjs";
import { TABS, WEB_TABS } from "./score.mjs";

export const QUALITY = fileURLToPath(new URL(".", import.meta.url));
const DEFAULT_CONFIG = "quality/config.json";

export const CONFIG_DEFAULTS = {
  repo: null,
  name: null,
  tabs: null,
  web: false,
  targets: "quality/targets",
  collectors: "quality/collectors",
  ideals: "quality/ideals",
  packs: [],
  reviews: "quality/reviews",
  data: "quality/data",
  history: "quality/history",
  out: "quality/dist",
  tokens_css: null,
  // The page loads as one file: 1,000 KB, counted as 1,000,000 bytes of
  // UTF-8. Deterministic, so it blocks.
  budget: 1_000_000,
  issue_sync: null,
};
const PATHS = ["targets", "collectors", "ideals", "reviews", "data", "history", "out", "tokens_css"];

const TAB_ID = /^[a-z][a-z0-9-]*$/;

// Throws unless each pack tab id fits TAB_ID and is no template tab's id or another pack tab's.
function checkPackTabs(packTabs) {
  const seen = new Set(TABS.map(([id]) => id));
  for (const [id] of packTabs) {
    if (!TAB_ID.test(id)) throw new Error(`packs: tab id "${id}" must be lower-case letters, digits and dashes`);
    if (seen.has(id)) throw new Error(`packs: tab "${id}" is already a tab; rename the pack's`);
    seen.add(id);
  }
}

// The tabs a page shows, as [id, name] pairs; packTabs, the packs' own, join
// the default list and may be named by id.
export function resolveTabs({ tabs = null, web = false } = {}, packTabs = []) {
  checkPackTabs(packTabs);
  const names = new Map([...TABS, ...packTabs]);
  if (tabs === null) return [...TABS.filter(([id]) => web || !WEB_TABS.includes(id)), ...packTabs];
  if (!Array.isArray(tabs) || !tabs.length) throw new Error("tabs must be a list of tab ids");
  const out = tabs.map((t) => {
    if (typeof t === "string") {
      if (!names.has(t)) throw new Error(`tabs: unknown tab "${t}"; a tab of the repo's own is ["id", "Name"]`);
      return [t, names.get(t)];
    }
    if (Array.isArray(t) && t.length === 2 && t.every((x) => typeof x === "string" && x.trim()) && TAB_ID.test(t[0])) return t;
    throw new Error(`tabs: ${JSON.stringify(t)} is neither a template tab id nor ["id", "Name"]`);
  });
  const ids = out.map(([id]) => id);
  const twice = ids.find((id, i) => ids.indexOf(id) !== i);
  if (twice) throw new Error(`tabs: "${twice}" is listed twice`);
  return out;
}

const configPath = (root, file) => (file ? (isAbsolute(file) ? file : join(root, file)) : join(root, DEFAULT_CONFIG));
const repoUrl = (repo, env) => (repo ? `${(env.GITHUB_SERVER_URL ?? "https://github.com").replace(/\/$/, "")}/${repo}` : null);
const absolute = (root, p) => (p === null ? null : resolve(root, p));
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

// The config file's object as written, or {} when the repo has none.
function readRaw(path, named) {
  if (!named && !existsSync(path)) return {};
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path}: expected an object`);
  return raw;
}

// Throws on an unknown key or a bad repo or budget.
function checkRaw(raw, c) {
  const unknown = Object.keys(raw).filter((k) => k !== "comment" && !(k in CONFIG_DEFAULTS));
  if (unknown.length) throw new Error(`unknown config key${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}; known: ${Object.keys(CONFIG_DEFAULTS).join(", ")}`);
  if (c.repo !== null && !REPO_RE.test(c.repo)) throw new Error(`repo must be "owner/name", not "${c.repo}"`);
  if (!Number.isInteger(c.budget) || c.budget <= 0) throw new Error("budget must be a whole number of bytes");
  if (c.issue_sync !== null && !isSync(c.issue_sync)) throw new Error('issue_sync must be null or { "label": "area", "labels": { "tab": "area" }, "project": 3, "quick": ["metric.id"], "waiting": ["metric.id"] }');
}

// True for an issue_sync object: a label, and optional labels by tab, a project number and quick and waiting ids.
const isText = (v) => typeof v === "string" && v.trim() !== "";
const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const isLabels = (l) => l === undefined || (isObj(l) && Object.values(l).every(isText));
const isIds = (b) => b === undefined || (Array.isArray(b) && b.every(isText));
const isProject = (n) => n === undefined || (Number.isInteger(n) && n > 0);
const isSync = (s) => isObj(s) && isText(s.label) && Object.keys(s).every((k) => ["label", "labels", "project", "quick", "waiting"].includes(k)) && isLabels(s.labels) && isProject(s.project) && isIds(s.quick) && isIds(s.waiting);

// The settings for a run in `root`: the named config file, else
// quality/config.json when the repo has one, else the defaults. Paths come
// back absolute. ci, a run in CI, refuses a pack named by path. Throws on a
// bad file: a usage error.
export function loadConfig({ root = process.cwd(), file = null, env = process.env, ci = false } = {}) {
  const path = configPath(root, file);
  const raw = readRaw(path, Boolean(file));
  const c = { ...CONFIG_DEFAULTS, ...raw };
  checkRaw(raw, c);
  const repo = c.repo ?? (REPO_RE.test(env.GITHUB_REPOSITORY ?? "") ? env.GITHUB_REPOSITORY : null);
  const named = Boolean(file) || existsSync(path);
  const packs = resolvePacks(c.packs, { root: resolve(root), env, ci });
  const settings = {
    ...c,
    root: resolve(root),
    file: named ? path : null,
    repo,
    name: c.name ?? (repo ? repo.split("/")[1] : basename(resolve(root))),
    repoUrl: repoUrl(repo, env),
    packs,
    tabs: resolveTabs(c, packs.flatMap((p) => p.tabs)),
  };
  for (const k of PATHS) settings[k] = absolute(root, c[k]);
  settings.tokens_css ??= join(QUALITY, "render", "tokens.css");
  return settings;
}
