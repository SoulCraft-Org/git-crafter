// Session transcripts, path globs and protected clauses for the instructions
// collector (instructions.mjs).

import fs from 'node:fs';
import path from 'node:path';
import { exists, HEAD } from './instructions-lib.mjs';

const SIMPLE = { '*': '[^/]*', '?': '[^/]' };

function globstar(slash, depth) {
  return { re: slash ? '(?:.*/)?' : '.*', skip: slash ? 2 : 1, depth };
}

// The regex text for the glob character at i, the characters after it to
// skip, and the brace depth after it.
function globToken(glob, i, depth) {
  const c = glob[i];
  if (c === '*' && glob[i + 1] === '*') return globstar(glob[i + 2] === '/', depth);
  if (c in SIMPLE) return { re: SIMPLE[c], skip: 0, depth };
  if (c === '{') return { re: '(?:', skip: 0, depth: depth + 1 };
  if (c === '}' && depth) return { re: ')', skip: 0, depth: depth - 1 };
  if (c === ',' && depth) return { re: '|', skip: 0, depth };
  return { re: c.replace(/[.+^$()|[\]\\]/g, '\\$&'), skip: 0, depth };
}

// A paths glob as a regex over a path relative to the session's folder.
export function globRegex(glob) {
  let re = '';
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const tok = globToken(glob, i, depth);
    re += tok.re;
    depth = tok.depth;
    i += tok.skip;
  }
  return new RegExp(`^${re}$`);
}

// ----------------------------------------------------------- transcripts

// Main session transcripts (in a project folder itself, not under
// <session>/subagents/), newest start first, each with its subagent files.
export function mainSessions(projectsDir, match, subagentsDir, upTo) {
  const out = [];
  for (const d of fs.readdirSync(projectsDir).filter((n) => n.includes(match))) {
    const folder = path.join(projectsDir, d);
    for (const f of fs.readdirSync(folder).filter((n) => n.endsWith('.jsonl'))) {
      const file = path.join(folder, f);
      const start = firstTime(file);
      if (!(start <= upTo)) continue;
      const sub = path.join(folder, f.replace(/\.jsonl$/, ''), subagentsDir);
      out.push({ file, start, subagents: exists(sub) ? fs.readdirSync(sub).filter((n) => n.endsWith('.jsonl')).map((n) => path.join(sub, n)) : [] });
    }
  }
  return out.sort((a, b) => b.start - a.start);
}

// The first timestamp in a transcript's head, in epoch milliseconds.
export function firstTime(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(HEAD);
    const text = buf.subarray(0, fs.readSync(fd, buf, 0, HEAD, 0)).toString('utf8');
    for (const line of text.split('\n')) {
      const m = /"timestamp":"([^"]+)"/.exec(line);
      if (m && Number.isFinite(Date.parse(m[1]))) return Date.parse(m[1]);
    }
    return fs.fstatSync(fd).mtimeMs;
  } finally {
    fs.closeSync(fd);
  }
}

// Calls fn with each JSON record of a transcript, skipping lines that do not parse.
export function eachLine(file, fn) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (fn(o) === false) return;
  }
}

const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (typeof x === 'string' ? x : x?.text ?? '')).join('\n') : '');

const COMMAND = /^<command-name>\/?([\w:.-]+)<\/command-name>/;
const add = (map, k) => map.set(k, (map.get(k) ?? 0) + 1);

// One transcript record into the counts: a typed slash command, or a tool call.
function tally(o, uses, touchTools) {
  if (o.type === 'user') {
    // A typed slash command's record opens with its <command-name> tag;
    // only that name is read, never a prompt.
    const m = COMMAND.exec(typeof o.message?.content === 'string' ? o.message.content : '');
    if (m) add(uses.skills, m[1]);
  } else if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
    for (const c of o.message.content) if (c?.type === 'tool_use') toolUse(c, o, uses, touchTools);
  }
}

function toolUse(c, o, uses, touchTools) {
  const input = c.input ?? {};
  if (c.name === 'Skill' && input.skill) add(uses.skills, String(input.skill));
  else if (c.name === 'Agent' || c.name === 'Task') add(uses.agents, String(input.subagent_type || 'general-purpose'));
  else if (touchTools.has(c.name)) touched(input, o, uses.touched);
}

// A file a tool touched, relative to the session's folder, when inside it.
function touched(input, o, list) {
  const p = String(input.file_path ?? input.notebook_path ?? '');
  const rel = o.cwd && p ? path.relative(o.cwd, path.resolve(o.cwd, p)) : '';
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) list.push(rel);
}

// Skill, slash command and Agent names, and touched files relative to the
// session's folder, over the sessions given.
export function usesIn(sessions, touchTools) {
  const uses = { skills: new Map(), agents: new Map(), touched: [] };
  for (const s of sessions) {
    for (const file of [s.file, ...s.subagents]) {
      eachLine(file, (o) => {
        tally(o, uses, touchTools);
        return true;
      });
    }
  }
  return uses;
}

// --------------------------------------------------------------- clauses

// Each clause against the installed copy of its Git Crafter file: the longest
// mapped prefix decides where that copy is. Normalised as clause_check.py
// does: whitespace runs to one space, trimmed, lowercased.
export const normClause = (text) => text.replace(/\s+/g, ' ').trim().toLowerCase();
// The protected clauses missing from their installed copies, by the map of source to install folder.
export function checkClauses(clauses, map, at) {
  if (!Array.isArray(clauses) || !clauses.length) throw new Error('the clause list has no clauses');
  const prefixes = Object.keys(map).sort((a, b) => b.length - a.length);
  const cache = new Map();
  const missing = [];
  for (const c of clauses) {
    const prefix = prefixes.find((p) => c.file.startsWith(p));
    if (prefix === undefined) throw new Error(`no installed path for ${c.file} in params.installed_from_code_os`);
    const installed = at(path.join(map[prefix], c.file.slice(prefix.length)));
    if (!cache.has(installed)) cache.set(installed, normClause(fs.readFileSync(installed, 'utf8')));
    if (!cache.get(installed).includes(normClause(c.text))) missing.push(`${c.file}: ${c.id}`);
  }
  return { checked: clauses.length, missing };
}
