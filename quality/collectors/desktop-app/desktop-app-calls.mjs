// Calls for the desktop app collector (desktop-app.mjs): which skills, agent
// types and servers a session called, by name. Only tool names, the skill and
// agent names in a call's input and the name in a typed slash command's
// record are read; prompts and replies never are.

import { pluginOfName, pluginOfServer, serverOf } from './desktop-app-listings.mjs';

const COMMAND = /^<command-name>\/?([\w:.-]+)<\/command-name>/;

// An empty tally: the skills, agent types and servers called.
export function emptyCalls() {
  return { skills: new Set(), agents: new Set(), servers: new Set() };
}

function tallyUse(calls, use, { skill_tool: skillTool, agent_tool: agentTool }) {
  if (use.name === skillTool && use.input?.skill) calls.skills.add(String(use.input.skill));
  else if (use.name === agentTool && use.input?.subagent_type) calls.agents.add(String(use.input.subagent_type));
  const server = serverOf(use.name);
  if (server) calls.servers.add(server);
}

// Folds one transcript record into a tally: a typed slash command, or the
// tool calls of one assistant message.
export function tallyCalls(calls, record, params) {
  const content = record.message?.content;
  if (record.type === 'user' && typeof content === 'string') {
    const typed = COMMAND.exec(content);
    if (typed) calls.skills.add(typed[1]);
  } else if (record.type === 'assistant' && Array.isArray(content)) {
    for (const part of content) if (part?.type === 'tool_use') tallyUse(calls, part, params);
  }
}

// The plugins a tally reaches: by a skill or agent name, or by a server.
export function pluginsCalled(calls, known) {
  const byName = [...calls.skills, ...calls.agents].map(pluginOfName);
  const byServer = [...calls.servers].map((s) => pluginOfServer(s, known));
  return new Set([...byName, ...byServer].filter(Boolean));
}
