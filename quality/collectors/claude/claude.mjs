// Claude tab collector: the scorecard Claude Code sessions in one repo judge
// themselves on. Quality: whether what they ship holds up, and whether it is
// tested. Speed: how fast they deliver. Consumption: how few tokens and
// dollars each result costs.
//
// Which sessions: the folders under params.projects_dir (default
// ~/.claude/projects) whose name contains params.project_match. With none set, the match is projectMatch(root): the
// folder name Claude Code gives the repo's main checkout, so its worktree
// sessions match too. Nothing here names a path or an account.
//
// Privacy: transcripts are read in `local` mode only, from this account's own
// ~/.claude. pick() is the one place a transcript line is read, and it keeps
// numeric fields, ids, timestamps, PR links and the type and subtype enums.
// Message text, tool inputs and tool results never leave it. A rule's
// frontmatter keys are read by ruleLoadsAlways (blockers.mjs asks it), and no
// text leaves. Issue text from gh is matched for the PR numbers it names and
// never written out. The output holds aggregates only: no session ids, titles
// or content.
//
// Point in time: each metric reads the last N events up to now, where new
// work replaces old within hours, never a calendar window. Model calls: the
// last params.last.calls. Claude PRs: the last params.last.prs merged, or for
// a metric about opened PRs the last that many opened; tokens and cost per
// merged PR read the last params.last.consumption. A PR's tokens, cost and
// compactions are its linking session's, split evenly over the PRs that
// session opened and merged. Reverts and escaped bugs are the state of those
// PRs now. Each source names its N. Some detail rows add the all-time figure
// for comparison.
//
// Contract: quality/targets/claude.json lists every metric id. collect()
// returns each one as a value or as { could_not_check }, never throws for a
// missing tool, token or file, and never turns "could not read" into 0.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { joinGithub } from './claude-github.mjs';
import { allCouldNotCheck, computeMetrics } from './claude-metrics.mjs';
import { metricIds, num, TEMPLATE, TOKEN_KEYS, usageCounts } from './claude-lib.mjs';
import { redact } from '../lib/redact.mjs';

export { classifyChecks } from './claude-github.mjs';
export { lastN, metricIds, priceCall, SUBAGENT_USAGE_FROM, usageCounts, versionAtLeast } from './claude-lib.mjs';

export const area = 'claude';

// The project folder Claude Code keeps a checkout's sessions in is the
// checkout's absolute path with every character other than a letter or digit
// turned into a dash (observed in ~/.claude/projects; the docs name the folder,
// not the rule). A worktree's folder adds its own path to the main checkout's,
// so the main checkout's name matches both.
export function projectMatch(root) {
  const main = path.resolve(root).replace(/\/\.claude\/worktrees\/[^/]+.*$/, '');
  return main.replace(/[^A-Za-z0-9]/g, '-');
}

// The managed policy CLAUDE.md, by platform (code.claude.com/docs/en/memory,
// read 2026-11-03).
export function managedClaudeMd(platform = process.platform) {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/CLAUDE.md';
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode\\CLAUDE.md';
  return '/etc/claude-code/CLAUDE.md';
}

// GitHub owner and name from a remote URL, or null.
export function remoteRepo(url) {
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(url).trim());
  return m ? { owner: m[1], name: m[2] } : null;
}

// owner/name of the repo being measured: params.repo, else the one GitHub
// Actions names (GITHUB_REPOSITORY), else the root's origin remote; '' when
// none answers.
export async function ownRepo(root, params = {}, exec = defaultExec) {
  if (params.repo) return String(params.repo);
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    const r = remoteRepo(await exec('git', ['-C', root, 'remote', 'get-url', 'origin']));
    return r ? `${r.owner}/${r.name}` : '';
  } catch {
    return '';
  }
}

// A path param: "~/" is under home, an absolute path is itself, any other is
// under the repo root (the rule instructions.mjs's params follow).
export function resolvePath(p, { home = os.homedir(), root = '.' } = {}) {
  const s = String(p ?? '');
  return s.startsWith('~/') ? path.join(home, s.slice(2)) : path.isAbsolute(s) ? s : path.join(root, s);
}
// Where Claude Code keeps session transcripts, unless params.projects_dir says otherwise.
export const PROJECTS_DIR = '~/.claude/projects';
const transcriptsOf = (dir, match) => `${dir}/*${match}*/**/*.jsonl`;
const CI_REASON = 'transcripts live on the machine that ran the sessions; refreshed by a --local collect there';
const REPO = /^[\w.-]+\/[\w.-]+$/;

// How many of the latest events each metric reads; params.last overrides any
// of them. Pick N so each set turns over within hours at the repo's pace.
export const LAST = { calls: 1000, prs: 20, sessions: 5, consumption: 10 };

const run = promisify(execFile);
const defaultExec = async (cmd, args) => (await run(cmd, args, { maxBuffer: 64 * 1024 * 1024 })).stdout;
const defaultGh = (args) => defaultExec('gh', args);

// Every metric of this tab, with each home path and account name taken out
// of the text (redact.mjs).
export async function collect(opts = {}) {
  return redact(await gather(opts), opts.home);
}

async function gather({
  root = '.',
  mode,
  projectsDir,
  gh = defaultGh,
  now = new Date(),
  home = os.homedir(),
  params = TEMPLATE,
  last,
} = {}) {
  const p = params;
  const match = String(p.project_match || projectMatch(root));
  const projects = String(p.projects_dir || PROJECTS_DIR);
  const transcripts = transcriptsOf(projects, match);
  if (mode !== 'local') return allCouldNotCheck(CI_REASON, transcripts);
  // A match with no letter or digit (a root of /) is in every folder's name.
  if (!/[A-Za-z0-9]/.test(match)) return allCouldNotCheck(`the project match "${match}" would read every project folder; set params.project_match on quality/targets/claude.json`, transcripts);

  const dir = projectsDir ?? resolvePath(projects, { home, root });
  let t;
  try {
    t = readTranscripts(dir, match);
  } catch (err) {
    return allCouldNotCheck(`could not read transcripts (${err.code ?? err.message}); run where the sessions ran`, transcripts);
  }
  if (t.sessions.size === 0) {
    return allCouldNotCheck(`no transcripts match ${transcripts}; set params.project_match on quality/targets/claude.json`, transcripts);
  }

  const readAt = now.toISOString();
  const notCode = new Set(p.not_code_checks ?? []);
  const github = await joinGithub(t.sessions, gh, notCode);
  return computeMetrics(t, github, { now: now.getTime(), readAt, last: { ...LAST, ...p.last, ...last }, params: p, transcripts, notCode });
}

// ---------------------------------------------------------------- transcripts

// Each linked PR's session start, keyed "owner/name#n": the first timestamp
// of the session that linked it first, read through pick() like every metric
// here (lead-time.mjs reads it). Throws when the folder cannot be read.
export function prSessionStarts(projectsDir, match) {
  const first = new Map();
  for (const s of readTranscripts(projectsDir, match).sessions.values()) {
    for (const [key, linkedAt] of s.prs) if (!(first.get(key)?.linkedAt <= linkedAt)) first.set(key, { linkedAt, start: s.start });
  }
  return new Map([...first].map(([key, v]) => [key, v.start]));
}

// The only fields read from a transcript line. Nothing else leaves this function.
function pick(o) {
  const u = o.type === 'assistant' ? o.message?.usage : null;
  return {
    type: o.type,
    timestamp: o.timestamp,
    sessionId: o.sessionId,
    isSidechain: o.isSidechain === true,
    version: o.version,
    model: o.message?.model,
    // Dedupe key only: a reply is written once per content block, each copy
    // repeating the same usage, so summing lines would count it several times.
    messageId: o.message?.id ?? o.requestId,
    usage: u
      ? {
          input: num(u.input_tokens),
          output: num(u.output_tokens),
          cacheWrite: num(u.cache_creation_input_tokens),
          cacheRead: num(u.cache_read_input_tokens),
          // Cache writes by lifetime: 5-minute and 1-hour writes are priced apart.
          cacheWrite5m: num(u.cache_creation?.ephemeral_5m_input_tokens),
          cacheWrite1h: num(u.cache_creation?.ephemeral_1h_input_tokens),
        }
      : null,
    cost:
      o.type === 'cost-state'
        ? {
            added: num(o.totalLinesAdded),
            removed: num(o.totalLinesRemoved),
            durationMs: num(o.totalDuration),
            usd: num(o.totalCostUSD),
          }
        : null,
    pr: o.type === 'pr-link' ? { repo: o.prRepository, number: o.prNumber } : null,
    // Known from the type and subtype alone; the summary and metadata stay unread.
    compact: o.type === 'system' && o.subtype === 'compact_boundary',
  };
}

function listJsonl(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listJsonl(p));
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function readTranscripts(projectsDir, match) {
  const files = fs
    .readdirSync(projectsDir)
    .filter((d) => d.includes(match))
    .flatMap((d) => listJsonl(path.join(projectsDir, d)));
  const st = { sessions: new Map(), messages: new Map(), compactions: [], unparsable: 0 };
  for (const file of files) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => readLine(st, line, `${file}:${i}`));
  }
  return { files: files.length, sessions: st.sessions, messages: st.messages, compactions: st.compactions, unparsable: st.unparsable };
}

function parseRecord(line) {
  try {
    return pick(JSON.parse(line));
  } catch {
    return null;
  }
}

function readLine(st, line, where) {
  if (!line.trim()) return;
  const r = parseRecord(line);
  if (r === null) {
    st.unparsable += 1;
    return;
  }
  if (!r.sessionId) return;
  const s = st.sessions.get(r.sessionId) ?? { start: Infinity, cost: null, prs: new Map() };
  st.sessions.set(r.sessionId, s);
  const ts = Date.parse(r.timestamp);
  if (Number.isFinite(ts)) s.start = Math.min(s.start, ts);
  if (r.usage && usageCounts({ sidechain: r.isSidechain, version: r.version, at: ts })) noteMessage(st.messages, r, ts, where);
  foldRecord(st, s, r, ts);
}

function foldRecord(st, s, r, ts) {
  // cost-state totals are cumulative for the session, so the largest is the latest.
  if (r.cost && (!s.cost || r.cost.durationMs >= s.cost.durationMs)) s.cost = r.cost;
  if (r.pr && REPO.test(String(r.pr.repo)) && Number.isInteger(r.pr.number)) notePr(s, r.pr, ts);
  if (r.compact && Number.isFinite(ts)) st.compactions.push({ sessionId: r.sessionId, at: ts });
}

function noteMessage(messages, r, ts, where) {
  const key = r.messageId ?? where;
  const m = messages.get(key) ?? { sessionId: r.sessionId, sidechain: r.isSidechain, version: r.version, model: r.model, at: Infinity, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  // Copies of one reply repeat its usage or grow output as it streams; keep the largest.
  for (const k of TOKEN_KEYS) m[k] = Math.max(m[k], r.usage[k]);
  if (Number.isFinite(ts)) m.at = Math.min(m.at, ts);
  messages.set(key, m);
}

function notePr(s, pr, ts) {
  const key = `${pr.repo}#${pr.number}`;
  const at = Number.isFinite(ts) ? ts : Infinity;
  if (!s.prs.has(key) || at < s.prs.get(key)) s.prs.set(key, at);
}

// -------------------------------------------------------------- instructions

// A rule file loads at launch unless its frontmatter has `paths`, which loads
// it only with matching files (code.claude.com/docs/en/memory, "Path-specific
// rules", read 2026-11-03). Only the frontmatter's keys are read.
export function ruleLoadsAlways(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(4096);
    const text = head.subarray(0, fs.readSync(fd, head, 0, head.length, 0)).toString('utf8');
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    return !(m && /^paths\s*:/m.test(m[1]));
  } finally {
    fs.closeSync(fd);
  }
}
