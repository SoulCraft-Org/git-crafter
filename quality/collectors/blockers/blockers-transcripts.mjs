// Reading transcripts for the Blockers collector (blockers.mjs).

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { usageCounts } from '../claude/claude.mjs';
import { EDIT_TOOLS, GIT_BLOCK, GIT_NOTE, GUARD_BLOCK, HOOK_ERROR, HOOK_TYPES, PUSH_GATES, REVIEW_AGENT } from './blockers-core.mjs';
import { gitKind, segments, steps, words } from './blockers-shell.mjs';

// --------------------------------------------------------------- blocks

// What refused a call, from its error text: a guard rule, a hook, a permission
// check or a git hook gate. Null when nothing did, and the call simply failed.
export function classifyBlock(text, call = {}) {
  const guard = GUARD_BLOCK.exec(text);
  // The guard's message names each rule broken and, when it has one, its fix.
  if (guard) return { kind: 'guard', rules: guard[1].split(/,\s*/), fixNamed: /\bFix: /.test(text) };
  const hook = HOOK_ERROR.exec(text);
  if (hook) return { kind: 'hook', label: hookBlockLabel(hook, text) };
  if (/^Permission for this command was denied by a built-in Claude Code safety check/.test(text)) return { kind: 'permission', label: 'built-in safety check' };
  if (/^Permission to use \S+.* denied/.test(text)) return { kind: 'permission', label: 'permission rules' };
  const gate = call.git ? GIT_BLOCK.exec(text) : null;
  return gate ? { kind: 'git', label: gateLabel(call.git, gate[1]) } : null;
}

function hookBlockLabel(hook, text) {
  const command = hook[2] ?? '';
  if (/write_guard\.py/.test(command)) return 'write guard';
  if (/bash_guard\.py/.test(command)) return 'bash guard, no rule named';
  if (/you are a subagent/.test(text)) return 'app: task list in a subagent';
  if (/isolated git worktree/.test(text)) return 'app: edit outside the worktree';
  return `hook on ${hook[1]}`;
}

const gateLabel = (git, gate) => (git === 'push' || (git === 'both' && PUSH_GATES.has(gate)) ? 'pre-push' : 'pre-commit');

// --------------------------------------------------------------- transcripts

// Every .jsonl file under a folder, subfolders included.
function listJsonl(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listJsonl(p));
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

// Every transcript in the project folders whose name holds cfg.match, read and parsed.
export function readTranscripts(projectsDir, cfg) {
  const files = fs
    .readdirSync(projectsDir)
    .filter((d) => d.includes(cfg.match))
    .flatMap((d) => listJsonl(path.join(projectsDir, d)));
  if (!files.length) throw new Error(`transcripts: none match ${cfg.transcripts}`);
  return files.map(readTranscript);
}

// A finite number, else 0.
const num = (v) => (Number.isFinite(v) ? v : 0);
// A transcript record's message content as a list, else empty.
const contentOf = (o) => (Array.isArray(o.message?.content) ? o.message.content : []);
// The text of message content: a string as is, a list's text parts joined by lines.
const textOf = (content) =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => (typeof c === 'string' ? c : c?.text ?? '')).join('\n') : '';

// A subagent is a reviewer when its meta file's type or description says so.
// The description is its Agent call's, so a parallel reviewer's also names the
// PRs it reviews ("Review PR #394", "Review PRs #391 and #392", "review for PR
// 222"): reviewPrs lists them, and its tokens are charged to those PRs.
function reviewOf(file) {
  try {
    const meta = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
    const text = `${meta.agentType ?? ''} ${meta.description ?? ''}`;
    if (!REVIEW_AGENT.test(text)) return { reviewer: false, reviewPrs: [] };
    return { reviewer: true, reviewPrs: reviewedPrs(String(meta.description ?? '')) };
  } catch {
    return { reviewer: false, reviewPrs: [] };
  }
}

// The PR numbers a review description names: N or #N after "PR" or "PRs",
// with any more after "and" or a comma. A bare #N may be an issue, so it is not one.
export function reviewedPrs(text) {
  const out = new Set();
  for (const m of text.matchAll(/\bPRs?\s+#?(\d+)((?:\s*(?:,|and)\s*#?\d+)*)/gi)) {
    for (const n of `${m[1]} ${m[2]}`.match(/\d+/g)) out.add(Number(n));
  }
  return [...out];
}

// One transcript file, in line order: its tool calls with their results, its
// model calls (one per message.id), the hook text that entered it, and where
// it compacted. idx is the line number, the order every match below uses.
function readTranscript(file) {
  // A main transcript sits in the project folder itself; a subagent's under
  // <session>/subagents/. Both carry the session's id on every line.
  const t = { ...reviewOf(file), main: path.basename(path.dirname(file)) !== 'subagents', sessionId: null, start: Infinity, calls: [], messages: [], hooks: [], compactions: [] };
  const st = { calls: new Map(), messages: new Map() };
  fs.readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, idx) => {
      const o = parseLine(line);
      if (o) readRecord(t, st, o, idx, file);
    });
  t.messages = [...st.messages.values()].sort((a, b) => a.idx - b.idx);
  return t;
}

function parseLine(line) {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// Folds one transcript record into the transcript t and the read state st.
function readRecord(t, st, o, idx, file) {
  const at = Date.parse(o.timestamp);
  if (typeof o.sessionId === 'string') t.sessionId ??= o.sessionId;
  if (Number.isFinite(at)) t.start = Math.min(t.start, at);
  if (o.type === 'assistant') readAssistant(t, st, o, { at, idx, file });
  else if (o.type === 'user') readUser(st, o, at, idx);
  else if (o.type === 'attachment' && HOOK_TYPES.has(o.attachment?.type)) noteHook(t, o.attachment, at, idx);
  else if (o.type === 'system' && o.subtype === 'compact_boundary') t.compactions.push(idx);
}

function readUser(st, o, at, idx) {
  for (const c of contentOf(o)) if (c.type === 'tool_result' && st.calls.has(c.tool_use_id)) settle(st.calls.get(c.tool_use_id), c, at, idx);
}

function readAssistant(t, st, o, { at, idx, file }) {
  noteMessage(st.messages, o, { at, idx, file });
  for (const c of contentOf(o)) {
    if (c.type !== 'tool_use') continue;
    const call = toolCall(c, at, idx, o.cwd, o.gitBranch);
    st.calls.set(c.id, call);
    t.calls.push(call);
  }
}

// Records one model reply's tokens, keeping the largest usage among its streamed copies.
function noteMessage(messages, o, { at, idx, file }) {
  const u = o.message?.usage;
  if (!u || !usageCounts({ sidechain: o.isSidechain === true, version: o.version, at })) return;
  const id = o.message?.id ?? o.requestId ?? `${file}:${idx}`;
  const m = messages.get(id) ?? { id, at, idx, sidechain: o.isSidechain === true, tokens: 0, billable: 0 };
  // Copies of one reply repeat its usage or grow output as it streams; keep the largest.
  m.tokens = Math.max(m.tokens, num(u.input_tokens) + num(u.output_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens));
  // Billable leaves out cache reads, the basis of claude.tokens_per_merged_pr.
  m.billable = Math.max(m.billable, num(u.input_tokens) + num(u.output_tokens) + num(u.cache_creation_input_tokens));
  messages.set(id, m);
}

function noteHook(t, a, at, idx) {
  const text = textOf(a.content) || (typeof a.stderr === 'string' ? a.stderr : '');
  if (text || Number.isFinite(a.durationMs)) t.hooks.push({ label: hookLabel(a.hookName, text), at, idx, chars: text.length, ms: Number.isFinite(a.durationMs) ? a.durationMs : null });
}

// One tool call as the blockers read it; a Bash command is kept in memory only.
function toolCall(c, at, idx, cwd, branch) {
  const bash = c.name === 'Bash';
  const command = bash ? String(c.input?.command ?? '') : '';
  return {
    tool: c.name,
    // In memory only: matched against fix signals and replayed through the guard, never output.
    command,
    ...callMeta(c, cwd, branch),
    at,
    idx,
    ...(bash ? bashFacts(command) : { words: null, segments: null, steps: null, git: null }),
    // Another tool's input, as one key: the same call has the same key.
    inputKey: bash ? null : inputKeyOf(c.input),
    resultAt: NaN,
    resultIdx: Infinity,
    error: false,
    block: null,
    noteChars: 0,
  };
}

// Where a call ran, its tool family and the file an edit targets.
function callMeta(c, cwd, branch) {
  const edit = EDIT_TOOLS.has(c.name);
  return {
    cwd: typeof cwd === 'string' ? cwd : null,
    branch: typeof branch === 'string' && branch ? branch : null,
    family: c.name === 'Bash' ? 'Bash' : edit ? 'edit' : c.name,
    target: edit ? String(c.input?.file_path ?? c.input?.notebook_path ?? '') : null,
  };
}

// What a Bash command is compared by: its words, segments, steps as typed (the
// held check) and git verb.
const bashFacts = (command) => ({ words: words(command), segments: segments(command), steps: steps(command), git: gitKind(command) });

const inputKeyOf = (input) => (input && typeof input === 'object' ? createHash('sha256').update(JSON.stringify(input)).digest('hex') : null);

// Attaches a tool result to its call: time, error, the block it shows and git note size.
function settle(call, result, at, idx) {
  const text = textOf(result.content);
  call.resultAt = at;
  call.resultIdx = idx;
  call.error = result.is_error === true;
  call.block = call.error ? classifyBlock(text, call) : null;
  if (call.git) call.noteChars = text.split('\n').filter((l) => GIT_NOTE.test(l)).reduce((n, l) => n + l.length, 0);
}

// The ledger label for a hook by its event name and text.
function hookLabel(name = 'hook', text = '') {
  if (String(name).startsWith('SessionStart')) return 'session start hooks';
  if (/preview server/i.test(text)) return 'app: preview reminder';
  if (name === 'PreToolUse:Bash') return 'bash guard notes';
  return `hook: ${name}`;
}
