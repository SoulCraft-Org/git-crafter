// Turns for the desktop app collector (desktop-app.mjs): what each turn a
// person started did, which subagents and sub-sessions it launched, and how
// they ended. Tool names, a call's session id, a notice's status and the
// origin of a user record are read; prompts and replies never are.

const TOOL_USE_ID = /<tool-use-id>([^<]+)<\/tool-use-id>/;
const STATUS = /<status>([^<]+)<\/status>/;
const NOTICE = '<task-notification>';
const HOUR = 36e5;

const list = (v) => (Array.isArray(v) ? v : []);
const textOf = (content) => (typeof content === 'string' ? content : list(content).map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('\n'));

// An empty reading of one session: its turns, the open one, each tool call's
// name, the message of the last Agent call and whether anything was learned
// since, and what the session started and archived.
export function emptyTurns() {
  return { turns: [], open: null, tools: new Map(), agentMessage: null, learned: false, notices: [], started: [], archived: new Set(), lastAt: 0 };
}

function newTurn(at) {
  return { at, edits: 0, commands: 0, plan: 0, recap: 0, last: null, interrupted: false, agents: 0, late: 0 };
}

// A tool result: a started sub-session's id. Any result is something learned
// since the last Agent call, but that of an Agent call that only launched: a
// foreground agent's result holds its answer.
function onResult(state, part, record, params) {
  const name = state.tools.get(part.tool_use_id);
  if (name !== params.agent_tool || record.toolUseResult?.status !== params.async_status) state.learned = true;
  if (name !== params.session_tool) return;
  const id = new RegExp(String(params.session_id_pattern)).exec(textOf(part.content));
  if (id?.[1]) state.started.push({ id: id[1], at: Date.parse(record.timestamp) });
}

// A task notice: one that answers an Agent call is a subagent's end.
function onNotice(state, text, record, params) {
  const id = TOOL_USE_ID.exec(text)?.[1];
  if (state.tools.get(id) !== params.agent_tool) return;
  state.notices.push({ at: Date.parse(record.timestamp), status: STATUS.exec(text)?.[1] ?? '' });
}

function foldUser(state, record, params) {
  const content = record.message?.content;
  const results = list(content).filter((p) => p?.type === 'tool_result');
  for (const part of results) onResult(state, part, record, params);
  const text = textOf(content);
  // A notice, a message or a prompt: something new arrived.
  if (!results.length) state.learned = true;
  if (text.startsWith(NOTICE)) return onNotice(state, text, record, params);
  if (state.open && text.includes(params.interrupt_marker)) state.open.interrupted = true;
  if (results.length || record.isMeta || record.origin?.kind !== params.human_origin) return;
  state.open = newTurn(Date.parse(record.timestamp));
  state.turns.push(state.open);
  state.agentMessage = null;
}

// One tool call into the open turn's counts.
function count(turn, name, params) {
  turn.last = name;
  if (list(params.edit_tools).includes(name)) turn.edits += 1;
  else if (list(params.command_tools).includes(name)) turn.commands += 1;
  else if (name === params.plan_tool) turn.plan += 1;
  else if (name === params.recap_tool) turn.recap += 1;
}

// An Agent call is late when the turn's previous one went in an earlier
// message and nothing was learned between: the two could have gone together.
// A call sent after a result or a notice is taken to depend on it.
function onAgent(state, messageId) {
  if (state.open) {
    state.open.agents += 1;
    if (state.agentMessage && state.agentMessage !== messageId && !state.learned) state.open.late += 1;
  }
  state.agentMessage = messageId;
  state.learned = false;
}

function foldAssistant(state, record, params) {
  for (const use of list(record.message?.content).filter((p) => p?.type === 'tool_use')) {
    state.tools.set(use.id, use.name);
    if (use.name === params.archive_tool && use.input?.session_id) state.archived.add(String(use.input.session_id));
    if (state.open) count(state.open, use.name, params);
    if (use.name === params.agent_tool) onAgent(state, record.message?.id);
  }
}

// Folds one record of a main transcript into a session's reading.
export function foldTurn(state, record, params) {
  if (record.isSidechain) return;
  const at = Date.parse(record.timestamp);
  if (at > state.lastAt) state.lastAt = at;
  if (record.type === 'user') foldUser(state, record, params);
  else if (record.type === 'assistant') foldAssistant(state, record, params);
}

// A session is live while its last record is newer than params.idle_hours:
// its open last turn and unarchived sub-sessions may still be running.
const isLive = (state, now, params) => now - state.lastAt < Number(params.idle_hours) * HOUR;

// One turn's verdict: null for no work, else closed, open, asked or missed.
function verdict(turn, isLast, live, params) {
  if (!(turn.edits >= 1 || turn.commands >= 2)) return null;
  if (turn.interrupted || list(params.asking_tools).includes(turn.last)) return 'asked';
  if (turn.plan > 0 && turn.recap > 0) return 'closed';
  return isLast && live ? 'open' : 'missed';
}

// Every session's turns and sub-sessions, judged: a work turn is closed,
// missed or left out, and a sub-session archived, left or still live.
export function judge(states, now, params) {
  const out = { turns: [], asked: 0, open: 0, subs: [], liveSubs: 0, notices: [], agentTurns: [] };
  for (const state of states) {
    const live = isLive(state, now, params);
    state.turns.forEach((turn, i) => {
      const v = verdict(turn, i === state.turns.length - 1, live, params);
      if (v === 'asked') out.asked += 1;
      else if (v === 'open') out.open += 1;
      else if (v) out.turns.push({ at: turn.at, closed: v === 'closed' });
      if (turn.agents >= 2) out.agentTurns.push({ at: turn.at, calls: turn.agents, late: turn.late });
    });
    for (const sub of state.started) {
      const archived = state.archived.has(sub.id);
      if (!archived && live) out.liveSubs += 1;
      else out.subs.push({ at: sub.at, archived });
    }
    out.notices.push(...state.notices);
  }
  return out;
}
