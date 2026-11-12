// Settings and small helpers shared by the Blockers collector (blockers.mjs).

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { percentile } from '../github/github.mjs';

export const area = 'blockers';

const TARGETS = JSON.parse(fs.readFileSync(new URL('../../targets/blockers.json', import.meta.url), 'utf8'));
export const metricIds = TARGETS.map((t) => t.id);

// This repo's settings are params on quality/targets/blockers.json, each with
// a default that names no repo, path or person (config(), below).
export const TEMPLATE = Object.assign({}, ...TARGETS.map((t) => t.params ?? {}));
export const CI_REASON = 'transcripts and the guard log live on the machine that ran the sessions; refreshed by a --local collect there';
export const GH_SOURCE = 'gh api graphql: merged pullRequests, 20 to a query, with pinned reviews and every check run attempt of their last 30 commits';
export const LAST_CALLS = 1000;
export const PER = 100;
export const LAST_GUARD = 15;
export const LAST_GIT = 20;
export const LAST_PRS = 20;
// Hook output per session: the last LAST_SESSIONS main sessions by start (56
// in the 7 days to 2026-11-03, 8 a day: 5 turn over in about 15 hours).
export const LAST_SESSIONS = 5;

export const MIN = 6e4;
export const HOUR = 36e5;
export const RETRY_MS = 10 * MIN;
// How far a guard log line may sit from the block it marks.
export const MARK_MS = 5000;
// How long the guard replay may take.
export const REPLAY_MS = 60_000;
// The most steps of one blocked command the replay judges alone; the 36 guard
// blocks in this repo's transcripts to 2026-11-11 04:13 UTC had at most 31.
export const REPLAY_STEPS = 40;
export const SIMILAR = 0.6;
export const PR_PAGE = 20;
export const MAX_PAGES = 15;

export const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
export const HOOK_TYPES = new Set(['hook_success', 'hook_additional_context', 'hook_non_blocking_error', 'hook_blocking_error', 'hook_cancelled']);
export const RED = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE']);
export const PUSH_GATES = new Set(['main', 'not-head']);
// The guard names itself Git Crafter since 2026-11-11, Code-OS from 2026-11-02, Claude-OS before.
export const GUARD_BLOCK = /^PreToolUse:\S+ hook error: \[[^\]]*bash_guard\.py\]: Blocked by the (?:Git Crafter|Code-OS|Claude-OS) bash guard \(([^)]+)\)/;
export const HOOK_ERROR = /^PreToolUse:(\S+) hook error: (\[[^\]]*\])?/;
export const GIT_BLOCK = /BLOCKED \[([\w, -]+)\]/;
export const GIT_NOTE = /\b(WARN|INFRA) \[/;
export const REVIEW_AGENT = /review/i;
// Arguments that say nothing about what a command does: git and gh verbs
// every push or read shares, and redirection targets.
// Programs that only wrap the command after them.
export const WRAPPERS = new Set(['time', 'command', 'env', 'nohup', 'exec', 'builtin', 'noglob']);
export const STOP = new Set(['push', 'commit', 'add', 'origin', 'status', 'diff', 'log', 'show', 'grep', 'api', 'run', 'view', 'list', 'checks', 'true', 'false', '/dev/null']);

const run = promisify(execFile);
// Runs a program and returns its stdout, with room for a large gh answer.
export const defaultExec = async (cmd, args) => (await run(cmd, args, { maxBuffer: 64 * 1024 * 1024 })).stdout;
// Runs gh with these arguments and returns its stdout.
export const defaultGh = (args) => defaultExec('gh', args);

// A read that fails becomes { error }, so one missing source blanks only its own metrics.
export function attempt(read) {
  try {
    return read();
  } catch (err) {
    return { error: `could not read (${err.code ?? firstLine(err)})` };
  }
}

// An error's first line of stderr or message, cut to 160 characters.
export function firstLine(err) {
  return String(err?.stderr || err?.message || err).trim().split('\n')[0].slice(0, 160);
}

// ------------------------------------------------------------------ metrics

// The total of a list of numbers.
export const sum = (xs) => xs.reduce((a, b) => a + b, 0);
// A number rounded to `digits` decimals (1 by default).
export const round = (v, digits = 1) => Number(v.toFixed(digits));
// `part` as a percent of `whole`, to one decimal.
export const pct = (part, whole) => round((100 * part) / whole);
// The middle value of a list of numbers.
export const median = (xs) => percentile(xs, 0.5);
// One breakdown row: a label, its value and unit.
export const item = (label, value, unit) => ({ label, value, unit });
// `f` of the finite numbers in `xs`, or null when there are none.
export const orNull = (xs, f) => (xs.some(Number.isFinite) ? f(xs.filter(Number.isFinite)) : null);
// A time in ms as `YYYY-MM-DD HH:MM`, in UTC.
export const iso = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
// Sort order for blocks: the latest `at` first.
export const newestFirst = (a, b) => b.at - a.at;


