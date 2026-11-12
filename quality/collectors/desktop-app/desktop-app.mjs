// Claude desktop app tab collector: what the desktop app's Code sessions
// load and whether they use it.
//
//   desktop_app.connectors_broken   servers that failed or need a sign-in
//   desktop_app.plugins_unused      plugins loaded that no recent session called
//   desktop_app.connectors_unused   connected servers no recent session called
//   desktop_app.connectors_pending  servers still connecting at the first prompt
//   desktop_app.listing_tokens      the skill, agent, server and tool listings
//   desktop_app.turns_closed        work turns with a task list and a recap
//   desktop_app.sub_sessions_closed sub-sessions their starter archived
//   desktop_app.subagents_killed    subagent runs killed or failed
//   desktop_app.parallel_share      Agent calls sent together
//   desktop_app.subagent_start_tokens  the context a subagent starts with
//
// Every path, tool name and N is a param on quality/targets/desktop-app.json.
// Only a transcript whose entrypoint is params.entrypoint counts: a terminal
// session is not the desktop app's.
//
// Privacy: `local` mode only, from this account's own transcripts. Listing
// attachments are read for names and sizes, tool calls for names, a user
// record for its origin, and a subagent's first model call for its token
// counts. The output holds counts, plugin names and agent types; a server's
// name, a session id or error text never leaves, and prompts and replies are
// never read.
//
// Contract: collect() returns every id in the targets file, each a value or
// { could_not_check }; it never throws for a missing file, and never turns
// "could not read" into 0.

import fs from 'node:fs';
import os from 'node:os';
import { projectMatch, resolvePath } from '../claude/claude.mjs';
import { attempt, item } from '../instructions/instructions-lib.mjs';
import { eachLine, mainSessions } from '../instructions/instructions-sessions.mjs';
import { redact } from '../lib/redact.mjs';
import { emptyCalls, pluginsCalled, tallyCalls } from './desktop-app-calls.mjs';
import { emptyListing, foldListing, hasListing, isAppServer, pluginsIn, serverKind, serversIn } from './desktop-app-listings.mjs';
import { emptyTurns, foldTurn } from './desktop-app-turns.mjs';
import { subagentMetric, workMetrics } from './desktop-app-work.mjs';

export const area = 'desktop_app';

const TARGETS = JSON.parse(fs.readFileSync(new URL('../../targets/desktop-app.json', import.meta.url), 'utf8'));
export const metricIds = TARGETS.map((t) => t.id);
// The template's own params, merged as the engine merges a file's: the
// defaults for a bare call. The engine passes the repo's merged params.
export const PARAMS = Object.assign({}, ...TARGETS.map((t) => t.params ?? {}));

const CI_REASON = 'transcripts live on the machine that ran the sessions; refreshed by a --local collect there';
const LISTING_IDS = ['connectors_broken', 'connectors_pending', 'listing_tokens', 'plugins_unused', 'connectors_unused'];
const tokens = (bytes) => Math.round(bytes / 4);
// The usage window: at least the newest session, whatever the param says.
const usageWindow = (params) => Math.max(1, Math.floor(Number(params.usage_sessions)) || 1);

// Every metric of this tab, with each home path and account name taken out
// of the text (redact.mjs).
export async function collect(opts = {}) {
  return redact(await gather(opts), opts.home);
}

async function gather({ root = '.', mode, home = os.homedir(), now = new Date(), params: given = PARAMS } = {}) {
  const self = `the ${area} collector`;
  if (mode !== 'local') return all(CI_REASON, self);
  const params = { ...given, project_match: String(given.project_match || projectMatch(root)) };
  // A match with no letter or digit (a root of /) is in every folder's name.
  if (!/[A-Za-z0-9]/.test(params.project_match)) return all(`the project match "${params.project_match}" would read every project folder; set params.project_match in this tab's targets file`, self);
  const sessions = attempt(() => desktopSessions(resolvePath(params.projects_dir, { home, root }), params, now.getTime()));
  if (sessions.error) return all(sessions.error, self);
  if (!sessions.length) return all(`no desktop session (entrypoint ${params.entrypoint}) in a folder naming ${params.project_match}`, self);
  const out = {};
  const readAt = now.toISOString();
  const val = (id, value, source, detail) => {
    out[`${area}.${id}`] = { value, detail, source, read_at: readAt };
  };
  const cnc = (id, reason, source) => {
    out[`${area}.${id}`] = { could_not_check: reason, source };
  };
  const latest = sessions[0].listing;
  if (hasListing(latest)) {
    stateMetrics(latest, params, val);
    usageMetrics(sessions.slice(0, usageWindow(params)), params, { val, cnc });
  } else for (const id of LISTING_IDS) cnc(id, 'the newest desktop session holds no listing attachment', self);
  workMetrics(sessions, params, now, { val, cnc });
  subagentMetric(sessions, params, now, { val, cnc });
  return Object.fromEntries(metricIds.map((id) => [id, out[id] ?? { could_not_check: 'collector produced no value', source: self }]));
}

// One transcript in a single pass: its entrypoint, its listings, its calls
// and its turns.
function readSession(file, params) {
  const read = { entrypoint: null, listing: emptyListing(), calls: emptyCalls(), turns: emptyTurns() };
  eachLine(file, (record) => {
    read.entrypoint ??= record.entrypoint ?? null;
    foldListing(read.listing, record);
    tallyCalls(read.calls, record, params);
    // A turn reading that fails (a pattern param that is no regex) stops
    // for this session and is reported; the listings and calls still read.
    if (!read.turnsError) read.turnsError = attempt(() => foldTurn(read.turns, record, params))?.error;
  });
  return read;
}

// Every desktop session, newest first, each with its subagent transcripts.
// Inside the usage window a subagent's calls count as its session's.
function desktopSessions(projectsDir, params, upTo) {
  const found = [];
  for (const session of mainSessions(projectsDir, params.project_match, params.subagents_dir, upTo)) {
    const read = readSession(session.file, params);
    if (read.entrypoint !== params.entrypoint) continue;
    if (found.length < usageWindow(params)) for (const sub of session.subagents) eachLine(sub, (record) => tallyCalls(read.calls, record, params));
    found.push({ ...read, subagents: session.subagents });
  }
  return found;
}

// The three readings of the newest session's listings alone.
function stateMetrics(latest, params, val) {
  const { needsAuth, failed } = latest.last;
  // A server the app adds itself is not the user's to speed up or switch off.
  const pending = latest.first.pending.filter((s) => !isAppServer(s, params.app_servers));
  val('connectors_broken', needsAuth.length + failed.length, 'state: the last tool listing of the newest desktop session', [item('need sign-in', needsAuth.length, 'servers'), item('failed to connect', failed.length, 'servers')]);
  val('connectors_pending', pending.length, 'state: the first tool listing of the newest desktop session, the app\'s own servers set aside', [item('still connecting', pending.length, 'servers')]);
  const parts = [
    ['tool names', latest.bytes.tools],
    ['skills', latest.bytes.skills],
    ['agents', latest.bytes.agents],
    ['server instructions', latest.bytes.instructions],
  ].map(([label, bytes]) => item(label, tokens(bytes), 'tokens'));
  val('listing_tokens', parts.reduce((n, p) => n + p.value, 0), 'state: bytes / 4 of the four listings of the newest desktop session, every delta added up', parts);
}

// The two readings that set the newest session's listings against what the
// last N sessions called.
function usageMetrics(sessions, params, { val, cnc }) {
  const n = Number(params.usage_sessions);
  const source = `state: the newest desktop session's listings against the calls of the last ${n} desktop sessions with their subagents; N = ${n} sessions, ${sessions.length} read`;
  if (!(n >= 1)) {
    for (const id of ['plugins_unused', 'connectors_unused']) cnc(id, 'params.usage_sessions must be at least one session', source);
    return;
  }
  const latest = sessions[0].listing;
  const calls = emptyCalls();
  for (const s of sessions) for (const kind of Object.keys(calls)) for (const name of s.calls[kind]) calls[kind].add(name);
  const loaded = pluginsIn(latest);
  const called = pluginsCalled(calls, loaded);
  const idle = [...loaded].filter((p) => !called.has(p)).sort();
  val('plugins_unused', idle.length, source, [item('plugins loaded', loaded.size, 'plugins'), item('plugins called', loaded.size - idle.length, 'plugins'), ...idle.map((p) => item(p, 0, 'calls'))]);
  // The app's own servers, and any kind a repo's params say its owner keeps, are set aside.
  const kept = Array.isArray(params.kept_kinds) ? params.kept_kinds : [];
  const servers = serversIn(latest).filter((s) => !isAppServer(s, params.app_servers) && !kept.includes(serverKind(s)));
  const unused = servers.filter((s) => !calls.servers.has(s));
  const kinds = ['plugin servers', 'account connectors', 'other servers'];
  val('connectors_unused', unused.length, source, [
    item('servers connected', servers.length, 'servers'),
    item('servers called', servers.length - unused.length, 'servers'),
    ...kinds.map((kind) => item(`${kind} unused`, unused.filter((s) => serverKind(s) === kind).length, 'servers')),
  ]);
}

function all(reason, source) {
  return Object.fromEntries(metricIds.map((id) => [id, { could_not_check: reason, source }]));
}
