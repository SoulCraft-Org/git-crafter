// What each block came to, and the guard replay (blockers.mjs).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LAST_CALLS, LAST_GUARD, LAST_SESSIONS, REPLAY_MS, REPLAY_STEPS, RETRY_MS, firstLine, newestFirst } from './blockers-core.mjs';
import { sameCall, segments, similar, steps, words } from './blockers-shell.mjs';
import { DISCARDED, neutralStep, writesFile } from './blockers-neutral.mjs';

// What a block came to, from the calls after it in its transcript within
// RETRY_MS. Ambiguities read as false alarm and known workaround families are
// vetoed; a workaround sharing no words with the blocked command and hitting
// no veto can still read held. Held: 'none' (no
// similar call succeeded), or every similar call that succeeded ran only the
// blocked command's own steps, as typed, steps that match the rule's fix
// signals and write no file, and neutral steps (neutralStep()): 'fixed' when
// one of those is a fix, 'dropped' when none is. A held block the current guard still
// blocks under another rule reads 'narrowed'. False alarm: 'replayed' (the
// current guard breaks no rule on it), 'same' (essentially the same call ran
// unblocked) or 'unfixed' (a similar success ran a step of its own, or any
// success in the window matched a veto). 'unread': the blocked call cannot be read.
export function outcomeOf(call, later, { fixes = new Map() } = {}) {
  if (call.family === 'Bash' ? !call.segments.length : call.inputKey === null) return 'unread';
  if (call.allowedNow === true) return 'replayed';
  const runs = later.filter((c) => !c.block && c.family === call.family && c.at - call.at <= RETRY_MS);
  if (runs.some((c) => sameCall(call, c) === true)) return 'same';
  const isSimilar = (c) => similarCall(call, c);
  const signals = (call.block?.rules ?? [call.block?.label]).flatMap((r) => fixes.get(r) ?? []);
  const hits = (c, re) => re.test(c.command ?? '') || (c.steps ?? []).some((step) => re.test(step) || re.test(signalForm(step)));
  // However few words it shares, a command that runs a known workaround anywhere in
  // the window is a retry, and so is the first command after the block when it runs
  // a fix. A later fix-like command (a git push, an ls) is other work, not a retry.
  const first = runs.find((c) => !c.error);
  const ran = runs.filter((c) => !c.error && (isSimilar(c) || signals.some((x) => x.veto && hits(c, x.re)) || (c === first && signals.some((x) => hits(c, x.re)))));
  if (ran.some((c) => signals.some((x) => x.veto && hits(c, x.re)))) return 'unfixed';
  const held = heldAs(call, ran, signals);
  if (!held) return 'unfixed';
  return call.narrowed === true ? 'narrowed' : held;
}
// Another call of the same family that does the same kind of thing.
function similarCall(call, c) {
  if (call.family === 'Bash') return similar(call.words, c.words);
  return call.family === 'edit' ? call.target === c.target : true;
}
const FALSE_ALARM = new Set(['replayed', 'same', 'unfixed', 'marked']);

// A step as a fix signal reads it (#215): a discarded redirection, a leading
// timeout and git's -C dir change where or how long it runs, not what it does,
// so `timeout 60 node --test a.test.mjs 2>&1` and `git -C "$W" merge
// --ff-only` match their signals. Matching and own-step checks use this form.
export function signalForm(step) {
  return String(step)
    .replace(DISCARDED, ' ')
    .replace(/^timeout( -[a-zA-Z]+( [^\s-]\S*)?)* \d+[smhd]? /, '')
    .replace(/^git( -C ('[^']*'|"[^"]*"|[^\s'"])\S*)+(?= )/, 'git')
    .replace(/\s+/g, ' ')
    .trim();
}

// How a block held, or null when it did not: every similar success may run
// only the blocked command's own steps, unchanged, fix steps that write no
// file, neutral steps, and, in a call that runs the fix itself, edits of
// steps the guard did not block (editOf()). A drop or a route-around with no
// fix in the same call still fails.
// Another tool's similar success has no steps to check, so it never holds.
function heldAs(call, ran, signals) {
  if (!ran.length) return 'none';
  if (call.family !== 'Bash') return null;
  const kindOf = stepKinds(call, signals);
  const each = ran.map((c) => new Set(c.steps.map(kindOf)));
  if (each.some((kinds) => kinds.has(null) || (kinds.has('edit') && !kinds.has('fix')))) return null;
  return each.some((kinds) => kinds.has('fix')) ? 'fixed' : 'dropped';
}

// What a retry's step is to the blocked call: 'own' (one of its steps, as
// typed), 'fix', 'neutral', 'edit' (editOf()), or null, a step of its own.
function stepKinds(call, signals) {
  const own = new Set(call.steps.map(signalForm));
  const isEdit = editOf(call);
  return (step) => {
    if (own.has(signalForm(step))) return 'own';
    if (isFix(step, signals)) return 'fix';
    if (neutralStep(step)) return 'neutral';
    return isEdit(step) ? 'edit' : null;
  };
}

// A step that applies the fix: it matches a fix signal and writes no file.
const isFix = (step, signals) => !writesFile(step) && signals.some((x) => !x.veto && x.re.test(signalForm(step)));

// A step's first two words, as signalForm() reads it: git fetch, python3 -I.
const head = (step) => signalForm(step).split(' ').slice(0, 2).join(' ');

// A blocked step's command word: the word after its program (checkout in
// git checkout -- ., --test in node --test dir/).
const commandWord = (step) => signalForm(step).split(' ')[1] ?? '';

// Whether a step edits one the guard did not block: its first two words are
// an unblocked step's and no blocked step's, and it holds no blocked step's
// command word anywhere (a heredoc that runs git checkout -- . through
// subprocess is no edit). The blocked steps come from the guard replay of
// each step (blockedSteps); without them no step is an edit.
function editOf(call) {
  const blocked = call.blockedSteps;
  if (!Array.isArray(blocked) || !blocked.length) return () => false;
  const banned = new Set(blocked.map(head));
  const free = new Set(call.steps.filter((s) => !blocked.includes(s)).map(head).filter((h) => !banned.has(h)));
  const words = [...new Set(blocked.map(commandWord).filter(Boolean))].map((w) => new RegExp(`(?<![\\w-])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`));
  return (step) => free.has(head(step)) && !words.some((re) => re.test(step));
}

// The guard's own verdict on each blocked command now: python3 loads the
// guard script and its rules file beside it and calls its evaluate(); the
// commands go on stdin, never argv, and nothing is logged. Anything the guard
// prints goes to stderr, so stdout carries only the replay's own lines: first
// the rules whose verdict reads the checkout's branch (push_from_branch), then
// one line per item. Resolves to { verdicts, branchRules }: verdicts maps each
// item's id to the rule ids it breaks now (null: the guard raised). Rejects
// when the replay cannot run or its output cannot be read.
const REPLAY_PY = [
  'import importlib.util, json, os, sys',
  'emit, sys.stdout = sys.stdout, sys.stderr',
  'spec = importlib.util.spec_from_file_location("guard", sys.argv[1])',
  'mod = importlib.util.module_from_spec(spec)',
  'spec.loader.exec_module(mod)',
  'path = os.path.join(os.path.dirname(sys.argv[1]), "bash_guard_rules.json")',
  'rules = mod.load_rules(path)',
  'raw = json.load(open(path))',
  'listed = raw.get("rules", []) if isinstance(raw, dict) else raw',
  'branch = sorted(r["id"] for r in listed if isinstance(r, dict) and "push_from_branch" in json.dumps(r))',
  'emit.write(json.dumps({"branch_rules": branch}) + "\\n"); emit.flush()',
  'for line in sys.stdin:',
  '    o = json.loads(line)',
  '    try:',
  '        out = sorted({h[0] for h in mod.evaluate(o["command"], rules, o.get("cwd"))})',
  '    except Exception:',
  '        out = None',
  '    emit.write(json.dumps({"id": o["id"], "rules": out}) + "\\n"); emit.flush()',
].join('\n');
// Replays each blocked command through the current guard script in python3 and resolves to its verdicts.
export function replayGuard(script, items) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(script)) return reject(new Error('no guard script'));
    const py = spawn('python3', ['-I', '-c', REPLAY_PY, script], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, BASH_GUARD_LOG: os.devnull } });
    let out = '';
    let err = '';
    const timer = setTimeout(() => py.kill(), REPLAY_MS);
    py.stdout.on('data', (d) => (out += d));
    py.stderr.on('data', (d) => (err += d));
    py.stdin.on('error', () => {});
    py.on('error', reject);
    py.on('close', (code) => {
      clearTimeout(timer);
      // The exception's type only: the rest of a traceback can quote a command.
      const type = /^\w+(Error|Exception)\b/.exec(err.trim().split('\n').at(-1) ?? '');
      if (code !== 0) return reject(new Error(`the replay exited ${code}${type ? `: ${type[0]}` : ''}`));
      const verdicts = new Map();
      let branchRules = new Set();
      try {
        for (const line of out.split('\n')) {
          if (!line.trim()) continue;
          const o = JSON.parse(line);
          if (Array.isArray(o.branch_rules)) branchRules = new Set(o.branch_rules);
          else if (Number.isInteger(o.id)) verdicts.set(o.id, o.rules);
        }
      } catch {
        return reject(new Error('the replay printed a line that is not JSON'));
      }
      resolve({ verdicts, branchRules });
    });
    for (const it of items) py.stdin.write(`${JSON.stringify(it)}\n`);
    py.stdin.end();
  });
}

// Replays the guard blocks the metrics read (those in the last LAST_CALLS
// tool calls, and the newest LAST_GUARD) through the current guard, and marks
// each call allowedNow when the guard breaks no rule on it at all, or narrowed
// when the rules it named stopped firing but another still blocks it. Each
// replays with the transcript's full command and the cwd it ran in, even a
// folder since removed: a path rule only joins it to a relative path. A rule
// that reads the checkout's branch counts only when that folder still exists
// on the branch the transcript recorded. Returns { replayed: n } or { error }
// when the replay cannot run.
export async function replayRecent(files, now, script, replay, exec) {
  const calls = files.flatMap((f) => f.calls).filter((c) => c.at <= now).sort(newestFirst);
  const cutoff = calls.length ? calls[Math.min(LAST_CALLS, calls.length) - 1].at : Infinity;
  const guarded = calls.filter((c) => c.block?.kind === 'guard' && c.command);
  const wanted = [...new Set([...guarded.filter((c) => c.at >= cutoff), ...guarded.slice(0, LAST_GUARD)])];
  if (!wanted.length) return { replayed: 0 };
  try {
    const { items, stepIds } = replayItems(wanted);
    const { verdicts, branchRules } = await replay(script, items);
    const branches = new Map();
    const branchNow = (dir) => {
      if (!branches.has(dir)) branches.set(dir, fs.existsSync(dir) ? exec('git', ['-C', dir, 'symbolic-ref', '--short', '-q', 'HEAD']).then((o) => String(o).trim() || null, () => null) : Promise.resolve(null));
      return branches.get(dir);
    };
    for (const [i, c] of wanted.entries()) {
      await markReplayed(c, verdicts.get(i), branchRules, branchNow);
      // A rule that reads the branch cannot be judged step by step in today's checkout.
      c.blockedSteps = c.block.rules.some((r) => branchRules.has(r)) ? null : blockedSteps(c, stepIds[i], verdicts);
    }
    return { replayed: wanted.length };
  } catch (err) {
    return { error: firstLine(err) };
  }
}

// The replay's items: each blocked command whole (id i), then each of its
// steps alone (ids after them, listed in stepIds[i]); a command of more than
// REPLAY_STEPS steps sends none, so it reads as before.
function replayItems(wanted) {
  const items = wanted.map((c, i) => ({ id: i, command: c.command, cwd: c.cwd }));
  const stepIds = wanted.map((c) => ((c.steps ?? []).length > REPLAY_STEPS ? [] : c.steps).map((step) => {
    items.push({ id: items.length, command: step, cwd: c.cwd });
    return items.length - 1;
  }));
  return { items, stepIds };
}

// The steps of a blocked call that break one of its block's rules alone, by
// the replay, or null when none does. A step the guard cannot parse alone (a
// heredoc that steps() puts on one line) is not one: the guard fails open on
// a parse error, so a readable step must explain the block.
function blockedSteps(c, ids, verdicts) {
  const out = ids.filter((id) => (verdicts.get(id) ?? []).some((r) => c.block.rules.includes(r))).map((id) => c.steps[ids.indexOf(id)]);
  return out.length ? out : null;
}

// Marks a call allowedNow when the current guard breaks no rule on it, or
// narrowed when the rules it named stopped firing but another still blocks it.
// A rule that reads the checkout's branch counts only while the folder is
// still on the branch the transcript recorded.
async function markReplayed(c, breaks, branchRules, branchNow) {
  if (!Array.isArray(breaks)) return;
  if (c.block.rules.some((r) => branchRules.has(r)) && !(c.cwd && c.branch && (await branchNow(c.cwd)) === c.branch)) return;
  c.allowedNow = breaks.length === 0;
  c.narrowed = breaks.length > 0 && !c.block.rules.some((r) => breaks.includes(r));
}

// Every block up to now with its outcome, time and tokens.
export function blocksOf(files, upTo, opts = {}) {
  const out = [];
  for (const f of files) {
    f.calls.forEach((call, i) => {
      if (!call.block || !(call.at <= upTo)) return;
      const outcome = outcomeOf(call, f.calls.slice(i + 1), opts);
      const next = f.calls[i + 1];
      const gap = next ? next.at - call.at : NaN;
      const answer = f.messages.find((m) => m.idx > call.resultIdx);
      const name = call.block.kind === 'guard' ? `guard: ${call.block.rules.join(', ')}` : call.block.label;
      out.push({ ...call.block, at: call.at, resultAt: call.resultAt, name, outcome, falseAlarm: FALSE_ALARM.has(outcome), ms: Number.isFinite(gap) ? Math.min(Math.max(gap, 0), RETRY_MS) : null, tokens: answer ? answer.tokens : null, billable: answer ? answer.billable : null, answer: answer ? answer.id : null });
    });
  }
  // Blocks refused together (parallel tool calls) are answered by one call;
  // they share its tokens, so the call counts once.
  const shared = new Map();
  for (const b of out) if (b.answer) shared.set(b.answer, (shared.get(b.answer) ?? 0) + 1);
  for (const b of out) if (b.answer) {
    b.tokens /= shared.get(b.answer);
    b.billable /= shared.get(b.answer);
  }
  return out;
}

// Model calls in a transcript after line `from`, up to its next compaction:
// the calls that read again whatever entered at `from`.
function readsAfter(f, from) {
  const end = Math.min(...f.compactions.filter((c) => c > from), Infinity);
  return f.messages.filter((m) => m.idx > from && m.idx < end).length;
}

// Hook text in the span, and the WARN and INFRA lines of git commit and
// push, as estimated tokens times the calls that read them.
export function notesOf(files, inSpan) {
  const out = [];
  for (const f of files) {
    for (const h of f.hooks) {
      if (inSpan(h.at)) out.push({ label: h.label, ms: h.ms, tokens: Math.ceil(h.chars / 4) * readsAfter(f, h.idx) });
    }
    for (const c of f.calls) {
      if (c.noteChars && inSpan(c.at)) out.push({ label: c.git === 'push' ? 'pre-push' : 'pre-commit', ms: null, tokens: Math.ceil(c.noteChars / 4) * readsAfter(f, c.resultIdx) });
    }
  }
  return out;
}

// The transcripts of the last LAST_SESSIONS main sessions that began by
// `upTo`, newest first: each a list of its files, the main one and its subagents.
export const sessionStart = (list) => Math.min(...list.filter((f) => f.main).map((f) => f.start));
// The newest LAST_SESSIONS sessions that started by upTo, each as its list of transcript files.
export function lastSessions(files, upTo) {
  const by = new Map();
  for (const f of files) if (f.sessionId) by.set(f.sessionId, [...(by.get(f.sessionId) ?? []), f]);
  return [...by.values()]
    .filter((list) => list.some((f) => f.main) && sessionStart(list) <= upTo)
    .sort((a, b) => sessionStart(b) - sessionStart(a))
    .slice(0, LAST_SESSIONS);
}
