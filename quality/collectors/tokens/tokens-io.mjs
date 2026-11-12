// What the Tokens collector reads from disk and GitHub: project folders,
// transcripts, linked PRs and the plan file (tokens.mjs turns them into metrics).

import fs from 'node:fs';
import path from 'node:path';
import { remoteRepo as githubRepo, usageCounts } from '../claude/claude.mjs';

const DAY = 24 * 36e5;
const PR_CHUNK = 50;
const PLAN_FRESH_MS = DAY;
const num = (v) => (Number.isFinite(v) ? v : 0);

// ---------------------------------------------------------------- folders

// GitHub owner and name from a remote URL, the name lowercased and a renamed
// repo under its current name, or null.
export function remoteRepo(url, alias = {}) {
  const r = githubRepo(url);
  if (!r) return null;
  const name = r.name.toLowerCase();
  return { owner: r.owner, name: alias[name] ?? name };
}

// Each project folder with the cwd its first transcript records and that
// cwd's repo, when it is one of ours.
export async function mapFolders(dir, exec, repos) {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const files = listJsonl(path.join(dir, name));
    const cwd = firstCwd(files);
    const found = cwd ? await lookupRepo(cwd, exec, repos) : { asked: false, repo: null, why: 'no transcript records a cwd' };
    const repo = found.asked ? found.repo : (repos.folders.find(([re]) => re.test(name))?.[1] ?? null);
    out.push({ name, files, repo, why: found.why });
  }
  return out;
}

// The repo a working directory belongs to, by its origin remote: the cwd, then
// its main checkout when the cwd was a worktree since removed. `asked` says git
// named a GitHub repo, ours or not.
async function lookupRepo(cwd, exec, repos) {
  for (const where of [cwd, cwd.replace(/\/\.claude\/worktrees\/[^/]+.*$/, '')]) {
    let url;
    try {
      url = await exec('git', ['-C', where, 'remote', 'get-url', 'origin']);
    } catch {
      continue;
    }
    const r = remoteRepo(url, repos.alias);
    if (r && repos.ours(r.owner, r.name)) return { asked: true, repo: r.name, why: null };
    return { asked: Boolean(r), repo: null, why: r ? 'a repo outside params.owners and params.repos' : 'no GitHub remote' };
  }
  return { asked: false, repo: null, why: 'no git remote' };
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

// The cwd field of the first transcript line that has one; only that field
// is read. Main transcripts first, then subagents'.
function firstCwd(files) {
  const sub = (p) => p.includes(`${path.sep}subagents${path.sep}`);
  for (const f of [...files.filter((p) => !sub(p)), ...files.filter(sub)]) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n', 5000)) {
      const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(line);
      if (m) return JSON.parse(`"${m[1]}"`);
    }
  }
  return null;
}

// --------------------------------------------------------------- transcripts

// Messages (one per message.id), sessions (start, active time, repo), PR
// links (each to the session that linked it first) and subagents.
export function readFolders(folders) {
  const st = { messages: new Map(), sessions: new Map(), links: new Map(), subagents: [] };
  for (const f of folders) for (const file of f.files) readTranscript(st, f, file);
  return { messages: [...st.messages.values()], sessions: st.sessions, links: [...st.links.values()], subagents: st.subagents };
}

function readTranscript(st, f, file) {
  const sub = file.includes(`${path.sep}subagents${path.sep}`) ? subagentOf(file, f.repo) : null;
  if (sub) st.subagents.push(sub);
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const o = parseLine(line);
    if (!o?.sessionId) continue;
    const at = Date.parse(o.timestamp);
    recordSession(st, o, f, sub, at);
    recordMessage(st, o, { f, file, sub, at });
    recordLink(st, o, at);
  }
}

function parseLine(line) {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function recordSession(st, o, f, sub, at) {
  const s = st.sessions.get(o.sessionId) ?? { repo: f.repo, start: Infinity, activeMs: null };
  if (Number.isFinite(at)) s.start = Math.min(s.start, at);
  if (sub && Number.isFinite(at)) sub.last = Math.max(sub.last, at);
  // Active work is model time plus tool time; totalDuration counts the hours a session sits open.
  if (o.type === 'cost-state' && Number.isFinite(o.totalAPIDuration)) s.activeMs = Math.max(s.activeMs ?? 0, o.totalAPIDuration + num(o.totalToolDuration));
  st.sessions.set(o.sessionId, s);
}

function recordMessage(st, o, { f, file, sub, at }) {
  const u = o.type === 'assistant' ? o.message?.usage : null;
  if (!u || !usageCounts({ sidechain: o.isSidechain === true, version: o.version, at })) return;
  const id = o.message?.id ?? o.requestId ?? `${file}:${at}`;
  const m = st.messages.get(id) ?? { sessionId: o.sessionId, repo: f.repo, at: Infinity, billable: 0, cacheRead: 0, input: 0 };
  // Copies of one reply repeat its usage, or grow output as it streams; keep the largest.
  m.billable = Math.max(m.billable, num(u.input_tokens) + num(u.output_tokens) + num(u.cache_creation_input_tokens));
  m.cacheRead = Math.max(m.cacheRead, num(u.cache_read_input_tokens));
  m.input = Math.max(m.input, num(u.input_tokens) + num(u.cache_creation_input_tokens));
  if (Number.isFinite(at)) m.at = Math.min(m.at, at);
  if (sub) {
    m.agent = sub;
    noteReply(sub, o.message, u, at);
  }
  st.messages.set(id, m);
}

// What a subagent returned: its last reply's text, which is all the parent
// receives, at 4 characters a token; thinking is never returned.
// A reply with no text block falls back to output_tokens.
function noteReply(sub, message, u, at) {
  const out = returnedTokens(message, u);
  if (at > sub.replyAt || (at === sub.replyAt && out > sub.returned)) [sub.replyAt, sub.returned] = [at, out];
}

function recordLink(st, o, at) {
  if (o.type !== 'pr-link' || !/^[\w.-]+\/[\w.-]+$/.test(String(o.prRepository)) || !Number.isInteger(o.prNumber)) return;
  const key = `${o.prRepository}#${o.prNumber}`;
  const prev = st.links.get(key);
  if (!prev || at < prev.at) st.links.set(key, { repo: o.prRepository, number: o.prNumber, sessionId: o.sessionId, at: Number.isFinite(at) ? at : Infinity });
}

// Tokens a subagent reply hands its parent: its text blocks at 4 characters
// a token (Anthropic's rough rate for English), else output_tokens.
export function returnedTokens(message, u = message?.usage) {
  const text = Array.isArray(message?.content) ? message.content.filter((b) => b?.type === 'text' && typeof b.text === 'string') : [];
  if (!text.length) return num(u?.output_tokens);
  return Math.ceil(text.reduce((n, b) => n + b.text.length, 0) / 4);
}

// A subagent transcript: its repo, its last line, and its last reply's
// output tokens, what it returns to its parent.
function subagentOf(file, repo) {
  return { repo, last: -Infinity, replyAt: -Infinity, returned: null };
}

// ------------------------------------------------------------------ github

async function graphql(exec, query) {
  let out;
  try {
    out = await exec('gh', ['api', 'graphql', '-f', `query=${query}`]);
  } catch (err) {
    out = err?.stdout;
    if (!out) throw err;
  }
  return JSON.parse(out);
}

// Every linked PR's state, times and pinned reviews, PR_CHUNK to a query. A PR
// GitHub does not have is skipped; any other error fails them all, since a
// missing PR would bias every ratio.
export async function readPulls(links, exec) {
  const byRepo = new Map();
  for (const l of links) byRepo.set(l.repo, [...(byRepo.get(l.repo) ?? []), l]);
  const found = new Map();
  let calls = 0;
  for (const [repo, list] of byRepo) {
    for (let i = 0; i < list.length; i += PR_CHUNK) {
      const chunk = list.slice(i, i + PR_CHUNK);
      const body = await graphql(exec, pullQuery(repo, chunk));
      calls += 1;
      addFound(found, body, repo, chunk);
    }
  }
  return { found, calls };
}

function addFound(found, body, repo, chunk) {
  for (const e of body.errors ?? []) if (e.type !== 'NOT_FOUND') throw new Error(String(e.message ?? e.type));
  for (const l of chunk) {
    const node = body.data?.repository?.[`p${l.number}`];
    if (node) found.set(`${repo}#${l.number}`, { ...node, link: l });
  }
}

function pullQuery(repo, chunk) {
  const [owner, name] = repo.split('/');
  const fields = 'state createdAt mergedAt headRefOid reviews(first: 50) { nodes { author { login } submittedAt commit { oid } } }';
  return `query { repository(owner: "${owner}", name: "${name}") { ${chunk.map((l) => `p${l.number}: pullRequest(number: ${l.number}) { ${fields} }`).join(' ')} } }`;
}

// ------------------------------------------------------------------- plan

// The weekly plan as a session last read it from the app (get_usage), written
// to params.plan_file; older than a day, or absent, it is not measured.
export function readPlan(root, now, PLAN_FILE) {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(root, PLAN_FILE), 'utf8'));
    const w = (doc.windows ?? []).find((x) => /weekly/i.test(x.label) && /all models/i.test(x.label));
    const readAt = Date.parse(doc.read_at);
    if (!w || !Number.isFinite(w.percentUsed) || !Number.isFinite(Date.parse(w.resetsAt))) return { error: `${PLAN_FILE} has no weekly all-models window` };
    if (readAt > now.getTime()) return { error: `${PLAN_FILE} says it was read after this run started; a clock or a hand edit is wrong` };
    if (!(now.getTime() - readAt <= PLAN_FRESH_MS)) return { error: `${PLAN_FILE} was read over a day ago; a session refreshes it from get_usage` };
    return { used: w.percentUsed, resetsAt: Date.parse(w.resetsAt), readAt, label: w.label };
  } catch (err) {
    return { error: `${PLAN_FILE}: ${err.code === 'ENOENT' ? 'absent; a session writes it from get_usage before a local run' : err.message}` };
  }
}
