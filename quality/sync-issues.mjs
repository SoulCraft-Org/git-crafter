#!/usr/bin/env node
// Syncs the Quality page's missed metrics to GitHub issues in the repo, one
// open issue per metric that misses its goal. The status is the page's own:
// build.mjs readInputs, the CI and local runs merged, scored by score.mjs.
//
//   node <code-os>/quality/sync-issues.mjs [--config FILE] [--dry-run]
//
// Off unless the repo's config sets issue_sync (config.mjs). Per metric on
// issue_sync.quick, or every metric when issue_sync.project is unset:
//
//   misses, no open issue  open one, typed Task, with its tab's area label
//   misses, open issue     update its table in place when Now changed, or
//                          only its format, keeping the old Change cell
//   near or not measured   leave it: the near band keeps a metric that sits
//                          on its goal from opening and closing on each push
//   meets, open issue      close it as completed
//   any other metric       the same on a draft card on the org project:
//                          Status Todo, or Waiting on data for an id on
//                          issue_sync.waiting, Pillar its kind, Area its
//                          label; Done when it meets. Its open issue closes
//                          as not planned, with one comment linking the card.
//                          The board needs env BOARD_TOKEN: without it, each
//                          card is only logged and no issue opens
//
// An issue or card is matched to its metric by a hidden marker line. One with
// several markers, or not the sync's own table, is hand-written: it covers its
// metrics and is never rewritten or closed. A run opens at most OPEN_CAP issues
// and cards and logs how many it held back. A closed issue
// is never reopened (the Issues tab counts reopens); a new miss opens a new one.
// Exit 0 synced or off, 1 a GitHub call failed, 2 usage error.

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { readInputs } from "./build.mjs";
import { loadConfig } from "./config.mjs";
import { mergeMetrics, scoreMetric, TABS } from "./score.mjs";

const MARK = /<!-- quality-metric: ([\w.-]+) -->/g;
const HEADER = "| Metric id | Now | Goal | Source | Change |";
// New issues one run may open: one bad snapshot cannot flood the Issues list.
export const OPEN_CAP = 5;
// The hidden line that ties an issue to its metric id.
export const marker = (id) => `<!-- quality-metric: ${id} -->`;
// Where pages.yml deploys the Quality page, under the repo's Pages site.
const PAGE_PATH = "quality/";

// A gh client over `gh api`: call(args, body) returns the parsed JSON; a token goes in GH_TOKEN, never logged.
export function ghCli(run = execFileSync, token = null) {
  const env = token ? { ...process.env, GH_TOKEN: token } : undefined;
  return (args, body) => {
    const input = body === undefined ? undefined : JSON.stringify(body);
    const out = run("gh", ["api", ...args, ...(input ? ["--input", "-"] : [])], { encoding: "utf8", input, env, stdio: ["pipe", "pipe", "inherit"] });
    return out.trim() ? JSON.parse(out) : null;
  };
}

// Each open issue that carries a marker, by metric id, for every marker it
// carries. One with several markers, or a body that is not the sync's own
// table, is hand-written: its metrics are covered and the sync never touches
// it. Pull requests are left out.
export function openByMetric(gh, repo) {
  const pages = gh(["--paginate", "--slurp", `repos/${repo}/issues?state=open&per_page=100`]);
  return byMarker(pages.flat().filter((i) => !i.pull_request));
}

// Items by the metric ids their bodies mark; an item with hand set stays hand-written.
function byMarker(items) {
  const byId = new Map();
  for (const item of items) {
    const body = item.body ?? "";
    const ids = [...body.matchAll(MARK)].map((m) => m[1]);
    const hand = Boolean(item.hand) || ids.length > 1 || !body.startsWith(marker(ids[0])) || !body.includes(HEADER);
    for (const id of ids) if (!byId.get(id) || hand) byId.set(id, { ...item, hand });
  }
  return byId;
}

const BOARD_READ = `query($owner:String!,$number:Int!,$after:String){organization(login:$owner){projectV2(number:$number){id
  fields(first:50){nodes{... on ProjectV2SingleSelectField{id name options{id name}}}}
  items(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{id databaseId
    content{... on DraftIssue{id body} ... on Issue{number body}}
    fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name}}}}}}}`;

// The org project: its id, its single-select fields by name, and its cards
// by metric id. A card already turned into an issue is hand-written: its PR owns it.
export function readBoard(gq, owner, number) {
  const nodes = [];
  let project = { items: { pageInfo: { hasNextPage: true, endCursor: null } } };
  while (project.items.pageInfo.hasNextPage) {
    project = gq(BOARD_READ, { owner, number, after: project.items.pageInfo.endCursor }).data.organization.projectV2;
    nodes.push(...project.items.nodes);
  }
  const fields = new Map(project.fields.nodes.filter((f) => f?.options).map((f) => [f.name, { id: f.id, options: new Map(f.options.map((o) => [o.name, o.id])) }]));
  const url = (dbId) => `https://github.com/orgs/${owner}/projects/${number}?pane=issue&itemId=${dbId}`;
  const items = nodes.map((n) => ({ item: n.id, url: url(n.databaseId), draft: n.content?.id ?? null, number: n.content?.number ?? null, body: n.content?.body, status: n.fieldValueByName?.name ?? null, hand: !n.content?.id }));
  return { gq, id: project.id, fields, url, cards: byMarker(items) };
}

// The page's status for every metric it shows: { def, entry, status }.
export function statuses(config) {
  const inputs = readInputs(config);
  if (inputs.code) return null;
  const metrics = mergeMetrics(inputs.local, inputs.latest);
  return inputs.defs.map((def) => ({ def, entry: metrics[def.id], status: scoreMetric(def, metrics[def.id]).status }));
}

const unitOf = (def, n) => `${n}${def.unit ? (def.unit === "%" ? "%" : ` ${def.unit}`) : ""}`;
const cell = (text) => String(text).replace(/[\\|]/g, "\\$&").replace(/\s+/g, " ");

// Ten cells, filled by closeness to the goal: 1 at the goal, 0.5 at the near
// band's edge, falling toward 0 the farther a miss sits beyond it.
export function meter(def, value) {
  const near = Number.isFinite(def.near) ? def.near : def.goal;
  const span = Math.abs(near - def.goal) || Math.abs(def.goal) || 1;
  const gap = Math.abs(value - def.goal);
  const filled = Math.max(0, Math.min(10, Math.round((10 * span) / (span + gap))));
  return "▰".repeat(filled) + "▱".repeat(10 - filled);
}

// The issue's body: the marker, one line (now, meter, goal, the metric on the
// Quality page when its address is known), then one table row. No prose paragraph.
export function issueBody({ def, entry }, change, page = null) {
  const goal = `${def.direction === "lower" ? "at most" : "at least"} ${unitOf(def, def.goal)}`;
  const now = unitOf(def, entry.value);
  const link = page ? ` · [Quality page](${page}#m-${def.id})` : "";
  const line = `🔴 ${now} · ${meter(def, entry.value)} · 🎯 ${goal}${link}`;
  const row = [def.id, now, goal, entry.source ?? def.file, change].map(cell);
  return `${marker(def.id)}\n\n${line}\n\n${HEADER}\n|---|---|---|---|---|\n| ${row.join(" | ")} |\n`;
}

// The Now and Change cells of a body issueBody wrote, or null.
const nowCell = (body) => /\n\| [\w.-]+ \| ([^|]+?) \|/.exec(body ?? "")?.[1] ?? null;
const changeCell = (body) => /\| ([^|\n]+?) \|\s*$/.exec(body ?? "")?.[1] ?? null;

// The Quality page's address from the repo's Pages site, or null when the
// token cannot read it: the body then goes without the link.
export function pageUrl(gh, repo) {
  try {
    const site = gh([`repos/${repo}/pages`])?.html_url;
    return typeof site === "string" && /^https:\/\//.test(site) ? `${site.replace(/\/?$/, "/")}${PAGE_PATH}` : null;
  } catch {
    return null;
  }
}

// What to do for one metric: { op, ... } or null when nothing changes. cards
// is the board's cards by metric id, or null when no token can read it.
export function plan(row, open, sync = {}, page = null, cards = null) {
  const issue = open.get(row.def.id);
  if (sync.project && !(sync.quick ?? []).includes(row.def.id)) return cardPlan(row, issue, cards, sync, page);
  if (row.status === "meets") return issue ? { op: "close", issue, row } : null;
  if (row.status !== "misses") return null;
  return issue ? updateStep(row, issue, page) : { op: "open", row, body: issueBody(row, "opened", page) };
}

// A board metric's step: its card's new body or Status, and an old issue to
// close linking the card. A card's own issue is never closed as its old issue.
function cardPlan(row, issue, cards, sync, page) {
  if (!cards) return row.status === "misses" ? { op: "log", row, issue } : null;
  const card = cards.get(row.def.id);
  const old = issue && issue.number !== card?.number ? issue : null;
  const step = cardStep(row, card, sync, page);
  if (!old) return step;
  if (step || card) return { ...(step ?? { op: "card", row, card }), issue: old };
  return row.status === "meets" ? { op: "close", issue: old, row } : null;
}

// The card's change: a new card or a new body or Status for a miss, Done for
// a meet. A hand-written card is never changed.
function cardStep(row, card, sync, page) {
  const reopen = (sync.waiting ?? []).includes(row.def.id) ? "Waiting on data" : "Todo";
  if (!card) return row.status === "misses" ? { op: "card", row, body: issueBody(row, "opened", page), status: reopen } : null;
  if (card.hand) return null;
  if (row.status === "meets") return card.status === "Done" ? null : { op: "card", row, card, status: "Done" };
  return row.status === "misses" ? missStep(row, card, reopen, page) : null;
}

// A missed metric's card: a new body when its Now cell moved, and Status back
// from Done.
function missStep(row, card, reopen, page) {
  const body = updateStep(row, card, page)?.body ?? null;
  const status = card.status === "Done" ? reopen : null;
  return body || status ? { op: "card", row, card, body, status } : null;
}

// An open issue's update when its Now cell no longer matches, else null. With
// Now the same, a body in an older format is rewritten with its old Change
// cell; without the page's address it waits, so a failed read never strips a link.
function updateStep(row, issue, page) {
  const was = nowCell(issue.body);
  if (was !== unitOf(row.def, row.entry.value)) return { op: "update", issue, row, body: issueBody(row, `was ${was ?? "unknown"}`, page) };
  const kept = changeCell(issue.body);
  const body = kept && page ? issueBody(row, kept, page) : null;
  return body && body !== issue.body ? { op: "update", issue, row, body } : null;
}

const tabName = (id) => new Map(TABS).get(id) ?? id;
const labelFor = (sync, tab) => sync.labels?.[tab] ?? sync.label;

const titleOf = (def) => `${tabName(def.tab)}: ${def.label} misses its goal`;
const pillarOf = (def) => (def.kind ? def.kind[0].toUpperCase() + def.kind.slice(1) : null);
const ADD = "mutation($p:ID!,$t:String!,$b:String){addProjectV2DraftIssue(input:{projectId:$p,title:$t,body:$b}){projectItem{id databaseId}}}";
const EDIT = "mutation($d:ID!,$b:String){updateProjectV2DraftIssue(input:{draftIssueId:$d,body:$b}){draftIssue{id}}}";

// Sets single-select fields on a card in one call; a field or option the board lacks is skipped with a warning.
function setFields(board, item, values) {
  const q = JSON.stringify;
  const sets = [];
  for (const [name, v] of Object.entries(values)) {
    if (v == null) continue;
    const f = board.fields.get(name);
    if (f?.options.has(v)) sets.push([f, v]);
    else console.warn(`::warning::quality: board has no ${name}=${v}`);
  }
  const each = sets.map(([f, v], i) => `f${i}:updateProjectV2ItemFieldValue(input:{projectId:${q(board.id)},itemId:${q(item)},fieldId:${q(f.id)},value:{singleSelectOptionId:${q(f.options.get(v))}}}){clientMutationId}`);
  if (each.length) board.gq(`mutation{${each.join(" ")}}`, {});
}

// One log line's words for a step.
function said(step) {
  const id = step.row.def.id;
  const n = step.issue ? ` #${step.issue.number}` : "";
  if (step.op === "log") return `no board token: card for ${id}, not an issue${step.issue ? `;${n} stays open` : ""}`;
  if (step.op !== "card") return `${step.op} ${id}${n}`;
  const what = step.card ? [step.body && "update", step.status && `to ${step.status}`].filter(Boolean).join(", ") || "link" : `new, ${step.status}`;
  return `card ${id}: ${what}${step.issue ? `, closes${n}` : ""}`;
}

// Writes a card step: the card, then the old issue's comment and close.
function applyCard(step, { gh, board, repo, sync }) {
  const { def } = step.row;
  let card = step.card;
  if (!card) {
    const made = board.gq(ADD, { p: board.id, t: titleOf(def), b: step.body }).data.addProjectV2DraftIssue.projectItem;
    card = { item: made.id, url: board.url(made.databaseId) };
    setFields(board, card.item, { Status: step.status, Pillar: pillarOf(def), Area: labelFor(sync, def.tab) });
  } else {
    if (step.body) board.gq(EDIT, { d: card.draft, b: step.body });
    if (step.status) setFields(board, card.item, { Status: step.status });
  }
  if (!step.issue) return;
  gh(["--method", "POST", `repos/${repo}/issues/${step.issue.number}/comments`], { body: `Moved to its board card: ${card.url}` });
  gh(["--method", "PATCH", `repos/${repo}/issues/${step.issue.number}`], { state: "closed", state_reason: "not_planned" });
}

// Carries out one step with gh and the board, or only logs it in a dry run.
export function apply(step, { gh, board = null, repo, sync, dryRun = false, log = console.log }) {
  const { def } = step.row;
  log(`${dryRun ? "[dry run] " : ""}${said(step)}`);
  if (dryRun || step.op === "log") return;
  if (step.op === "card") {
    applyCard(step, { gh, board, repo, sync });
  } else if (step.op === "open") {
    gh(["--method", "POST", `repos/${repo}/issues`], { title: titleOf(def), body: step.body, labels: [labelFor(sync, def.tab)], type: "Task" });
  } else if (step.op === "update") {
    gh(["--method", "PATCH", `repos/${repo}/issues/${step.issue.number}`], { body: step.body });
  } else {
    gh(["--method", "PATCH", `repos/${repo}/issues/${step.issue.number}`], { state: "closed", state_reason: "completed" });
  }
}

// The metric CodeQL measures; a count read before CodeQL finished on the commit is stale (#51).
export const CODEQL_METRIC = "security.code_scanning_open";

// A count stamped less than this long after a scan ended may predate it: the stamp follows the read,
// and the collect step ran 42 s and 38 s on the two merges measured for #51.
const SCAN_SETTLE_MS = 60_000;

// A code scanning run: default setup's path, or a workflow named for CodeQL; never Code Quality's.
const isScan = (r) => /codeql/i.test(`${r.path ?? ""} ${r.name ?? ""}`) && !/code-quality/i.test(r.path ?? "");

// True when the count read at readAt may predate a scan of sha: a scan run is unfinished, or it ended
// after the read or less than SCAN_SETTLE_MS before it. With no readAt, only an unfinished run counts.
// One request; a failed read is false, so the alert still syncs.
export function codeqlStale(gh, repo, sha, readAt) {
  try {
    const runs = gh([`repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`])?.workflow_runs ?? [];
    const read = Date.parse(readAt);
    return runs.some((r) => isScan(r) && (r.status !== "completed" || Date.parse(r.updated_at) > read - SCAN_SETTLE_MS));
  } catch {
    return false;
  }
}

// Plans and applies the sync for config; returns the steps taken.
// gq(query, variables) is the board's GraphQL client, or null with no token.
// sha is the commit built; a CODEQL_METRIC count that may predate its scan waits for the next run.
export function sync(config, { gh = ghCli(), gq = null, dryRun = false, log = console.log, sha = process.env.GITHUB_SHA } = {}) {
  const rows = statuses(config);
  if (!rows) return log("no quality run yet; nothing to sync"), [];
  const open = openByMetric(gh, config.repo);
  const page = pageUrl(gh, config.repo);
  const { project } = config.issue_sync;
  const board = project && gq ? readBoard(gq, config.repo.split("/")[0], project) : null;
  // A hand-written issue covers its metrics: the sync never touches them.
  let planned = rows.filter((row) => !open.get(row.def.id)?.hand).map((row) => plan(row, open, config.issue_sync, page, board?.cards ?? null)).filter(Boolean);
  const scan = planned.find((s) => s.row.def.id === CODEQL_METRIC && s.op !== "log");
  if (scan && sha && codeqlStale(gh, config.repo, sha, scan.row.entry?.read_at)) {
    log(`${CODEQL_METRIC} may predate CodeQL on ${sha.slice(0, 7)}: it waits for the next run`);
    planned = planned.filter((s) => s !== scan);
  }
  const opens = planned.filter((s) => s.op === "open" || (s.op === "card" && !s.card));
  const steps = planned.filter((s) => !opens.includes(s) || opens.indexOf(s) < OPEN_CAP);
  if (opens.length > OPEN_CAP) log(`held back ${opens.length - OPEN_CAP} new issue(s) or card(s) past the cap of ${OPEN_CAP}; the next run opens them`);
  for (const step of steps) apply(step, { gh, board, repo: config.repo, sync: config.issue_sync, dryRun, log });
  log(`${steps.length} step(s) for ${rows.filter((r) => r.status === "misses").length} missed metric(s)`);
  return steps;
}

// The CLI flags: --config FILE and --dry-run.
export function parseArgs(args) {
  const out = { config: null, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") out.dryRun = true;
    else if (args[i] === "--config" && args[i + 1] && !out.config) out.config = args[++i];
    else return null;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) return console.error("usage: node quality/sync-issues.mjs [--config FILE] [--dry-run]"), process.exit(2);
  let config;
  try {
    config = loadConfig({ file: args.config, ci: process.env.GITHUB_ACTIONS === "true" });
  } catch (err) {
    return console.error(`quality: ${err.message}`), process.exit(2);
  }
  if (!config.issue_sync) return console.log("issue_sync is off in the config; nothing to sync");
  if (!config.repo) return console.error("quality: issue_sync needs repo or GITHUB_REPOSITORY"), process.exit(2);
  try {
    const graphql = process.env.BOARD_TOKEN ? ghCli(execFileSync, process.env.BOARD_TOKEN) : null;
    sync(config, { gq: graphql && ((query, variables) => graphql(["graphql"], { query, variables })), dryRun: args.dryRun });
  } catch (err) {
    console.error(`::error::quality: issue sync failed: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
