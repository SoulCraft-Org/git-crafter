// Listings for the desktop app collector (desktop-app.mjs): what a session
// loads before any work, read from the attachment records Claude Code writes
// into a transcript, and the plugin or server each listed name belongs to.
// The attachment types are observed in transcripts, not named in Anthropic's
// public docs. Names and sizes are read; a server's error text never is.

const MCP = 'mcp__';
const PLUGIN_SERVER = 'plugin_';
const ACCOUNT_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

const list = (v) => (Array.isArray(v) ? v : []);
const size = (lines) => lines.reduce((n, l) => n + Buffer.byteLength(String(l)), 0);
// A server entry is its name, or a record that holds one beside an error.
const names = (v) => list(v).map((s) => (typeof s === 'string' ? s : String(s?.name ?? ''))).filter(Boolean);
const without = (all, gone) => (gone.length ? all.filter((n) => !gone.includes(n)) : all);

// An empty listing: names by kind, bytes by kind, and the server state at
// the session's first and last tool listing.
export function emptyListing() {
  return { skills: [], agents: [], instructed: [], tools: [], bytes: { tools: 0, skills: 0, agents: 0, instructions: 0 }, first: null, last: null };
}

// One attachment type each. A delta's bytes stay counted after a removal:
// what was sent stays in the session's context.
const FOLD = {
  skill_listing(out, a) {
    out.skills.push(...list(a.names));
    out.bytes.skills += Buffer.byteLength(String(a.content ?? ''));
  },
  agent_listing_delta(out, a) {
    out.agents = without([...out.agents, ...list(a.addedTypes)], list(a.removedTypes));
    out.bytes.agents += size(list(a.addedLines));
  },
  mcp_instructions_delta(out, a) {
    out.instructed = without([...out.instructed, ...list(a.addedNames)], list(a.removedNames));
    out.bytes.instructions += size(list(a.addedBlocks));
  },
  deferred_tools_delta(out, a) {
    out.tools = without([...out.tools, ...list(a.addedNames)], list(a.removedNames));
    out.bytes.tools += size(list(a.addedLines));
    const state = { pending: names(a.pendingMcpServers), needsAuth: names(a.needsAuthMcpServers), failed: names(a.failedMcpServers) };
    out.first ??= state;
    out.last = state;
  },
};

// Folds one transcript record into a listing; any other record is left alone.
export function foldListing(out, record) {
  if (record.type !== 'attachment') return;
  FOLD[record.attachment?.type]?.(out, record.attachment);
}

// True when the transcript held at least one tool listing.
export const hasListing = (listing) => Boolean(listing.last);

// The server a tool belongs to (mcp__<server>__<tool>), or null for a
// built-in tool. The cut is at the first double underscore after the prefix:
// a tool's own name may hold one, and a server whose name holds one still
// gets a single key for all its tools.
export function serverOf(tool) {
  const name = String(tool ?? '');
  const end = name.indexOf('__', MCP.length);
  return name.startsWith(MCP) && end > MCP.length ? name.slice(MCP.length, end) : null;
}

// The plugin of a listed name: "plugin:skill", "plugin:agent" or
// "plugin:<plugin>:<server>". A name with no colon belongs to none. Most
// plugins ship skills and no server, so the colon is the only evidence a
// listing gives; a repo whose own commands carry a colon would read as one.
export function pluginOfName(name) {
  const parts = String(name ?? '').split(':');
  if (parts.length < 2) return null;
  return parts[0] === 'plugin' ? parts[1] : parts[0];
}

// The plugin of a server as tool names spell it, plugin_<plugin>_<server>:
// the longest known plugin name that fits, else the first word.
export function pluginOfServer(server, known) {
  if (!server.startsWith(PLUGIN_SERVER)) return null;
  const rest = server.slice(PLUGIN_SERVER.length);
  const fits = [...known].filter((p) => rest.startsWith(`${p}_`)).sort((a, b) => b.length - a.length);
  return fits[0] ?? rest.split('_')[0];
}

// The servers a listing's tool names come from, each once.
export const serversIn = (listing) => [...new Set(listing.tools.map(serverOf).filter(Boolean))];

// Every plugin a listing names: by its skills, agents, instructions and
// server lists, then by the servers behind its tool names.
export function pluginsIn(listing) {
  const state = [listing.first, listing.last].filter(Boolean).flatMap((s) => [...s.pending, ...s.needsAuth, ...s.failed]);
  const known = new Set([...listing.skills, ...listing.agents, ...listing.instructed, ...state].map(pluginOfName).filter(Boolean));
  for (const server of serversIn(listing)) {
    const plugin = pluginOfServer(server, known);
    if (plugin) known.add(plugin);
  }
  return known;
}

// A server's kind, for a count that names no server: a plugin's, an account
// connector (an id), or any other.
export function serverKind(server) {
  if (server.startsWith(PLUGIN_SERVER)) return 'plugin servers';
  return ACCOUNT_ID.test(server) ? 'account connectors' : 'other servers';
}

// True for a server the app adds itself: an entry ending in _ is a prefix,
// any other a whole name.
export function isAppServer(server, appServers) {
  return list(appServers).some((entry) => (String(entry).endsWith('_') ? server.startsWith(entry) : server === entry));
}
