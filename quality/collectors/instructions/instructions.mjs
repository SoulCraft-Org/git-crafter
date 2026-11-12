// Instructions tab collector: drift and bloat in what Claude follows: the
// always-loaded files, the MEMORY index, the skill and agent listings and
// the clauses Git Crafter protects.
//
//   claude.instruction_tokens         always-loaded files, MEMORY index left out
//   instructions.memory_index_tokens  the head of MEMORY.md that loads
//   instructions.description_tokens   skill and agent names and descriptions
//   instructions.lines_before_action  lines of the largest always-loaded file
//                                     the repo controls
//   instructions.protected_clauses_missing  Git Crafter clauses gone from the
//                                     installed copy Claude reads
//   instructions.unused               rules, skills and agents no recent
//                                     session used
//
// Restated rules, broken references and copy drift are simplicity.mjs's and
// hook output per session is blockers.mjs's; they keep their ids on this tab.
//
// Every path is a param on quality/targets/instructions.json: a "~/" param is
// under home, an absolute one is itself, any other is under the repo root.
// Three have defaults that name no path: project_match (the repo's own project
// folder, projectMatch in claude.mjs), managed_claude_md (the platform's
// managed policy CLAUDE.md) and code_os_checkout (the Git Crafter checkout this
// collector runs from).
//
// Privacy: `local` mode only, from this account's own files. Files are read
// for sizes, line breaks, frontmatter keys and clause matches; transcripts for
// tool names, skill and agent names, touched file paths and
// the name in a typed slash command's <command-name> record. Prompts and
// replies are never read. The output holds counts and file, skill, agent and
// clause names, never text.
//
// Contract: collect() returns every id in the targets file, each a value or
// { could_not_check }; it never throws for a missing file, and never turns
// "could not read" into 0.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { managedClaudeMd, projectMatch } from '../claude/claude.mjs';
import { agentsIn, attempt, exists, item, iso, lineCount, listDir, loadsAlways, md, memoryHead, rulePaths, skillsIn, sum, toList } from './instructions-lib.mjs';
import { checkClauses, mainSessions, usesIn, globRegex } from './instructions-sessions.mjs';
import { redact } from '../lib/redact.mjs';

export { frontmatter, memoryHead, rulePaths } from './instructions-lib.mjs';
export { globRegex, normClause } from './instructions-sessions.mjs';

export const area = 'instructions';

const TARGETS = JSON.parse(fs.readFileSync(new URL('../../targets/instructions.json', import.meta.url), 'utf8'));
export const metricIds = TARGETS.map((t) => t.id);
// The template's own params, merged as the engine merges a file's: the
// defaults for a bare call. The engine passes the repo's merged params.
export const PARAMS = Object.assign({}, ...TARGETS.map((t) => t.params ?? {}));
// The Git Crafter checkout this file runs from: quality/collectors/ is two below it.
const KIT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const HOOK_TYPES = new Set(['hook_success', 'hook_additional_context', 'hook_non_blocking_error']);


// Every metric of this tab, with each home path and account name taken out
// of the text (redact.mjs).
export async function collect(opts = {}) {
  return redact(await gather(opts), opts.home);
}

async function gather({ root = '.', mode, home = os.homedir(), now = new Date(), params: given = PARAMS } = {}) {
  const self = `the ${area} collector`;
  if (mode !== 'local') return all('the files Claude loads live on the machine that ran the sessions; refreshed by a --local collect there', self);
  const params = {
    ...given,
    project_match: String(given.project_match || projectMatch(root)),
    managed_claude_md: given.managed_claude_md || managedClaudeMd(),
    code_os_checkout: given.code_os_checkout || KIT_ROOT,
  };
  // A match with no letter or digit (a root of /) is in every folder's name.
  if (!/[A-Za-z0-9]/.test(params.project_match)) return all(`the project match "${params.project_match}" would read every project folder; set params.project_match in this tab's targets file`, self);
  const out = {};
  const ctx = makeContext({ params, root, home, now, out });
  tokenMetric(ctx);
  const memory = memoryMetric(ctx);
  const listed = descriptionMetric(ctx);
  linesMetric(ctx, memory);
  clauseMetric(ctx);
  unusedMetric(ctx, listed);
  return Object.fromEntries(metricIds.map((id) => [id, out[id] ?? { could_not_check: 'collector produced no value', source: self }]));
}

// What every metric reads: the params, `at` (a param path made absolute),
// `fromRepo`, and val and cnc, which write a metric into `out`.
function makeContext({ params, root, home, now, out }) {
  const readAt = now.toISOString();
  // An empty param names no path, never the repo root.
  const at = (p) => (!p ? '' : p.startsWith('~/') ? path.join(home, p.slice(2)) : path.isAbsolute(p) ? p : path.join(root, p));
  // A param path printed for a reader: inside the repo it is relative to root
  // ('.' for root), inside the home folder it starts ~/, else as given. The
  // collector contract bars home paths in snapshots.
  const show = (p) => {
    const abs = at(p);
    if (!abs) return '';
    const inside = (base) => {
      const rel = path.relative(base, abs);
      return rel === '' ? '.' : rel.startsWith('..') || path.isAbsolute(rel) ? null : rel;
    };
    const rel = inside(root);
    if (rel !== null) return rel;
    const underHome = inside(home);
    return underHome === null ? abs : underHome === '.' ? '~' : '~/' + underHome;
  };
  return {
    params,
    root,
    home,
    now,
    at,
    show,
    // A user-level file counts as this repo's only when the repo holds its
    // source, by params.installed_from_code_os (source folder: install folder).
    // Another tool's skill, used in other projects, is not this repo's to remove.
    fromRepo: (file) =>
      Object.entries(params.installed_from_code_os ?? {}).some(([src, dst]) => {
        const rel = path.relative(at(dst), file);
        return rel && !rel.startsWith('..') && !path.isAbsolute(rel) && exists(path.join(root, src, rel));
      }),
    val: (id, value, source, detail) => {
      out[id] = { value, ...(detail ? { detail } : {}), source, read_at: readAt };
    },
    cnc: (id, reason, source) => {
      out[id] = { could_not_check: reason, source };
    },
  };
}

function tokenMetric(ctx) {
  const { params, at, val, cnc } = ctx;
  // Always-loaded files, by group: a file that is absent is not loaded.
  const groups = [
    ['managed CLAUDE.md', () => toList(params.managed_claude_md).map(at)],
    ['user CLAUDE.md', () => toList(params.user_claude_md).map(at)],
    ['repo CLAUDE.md', () => toList(params.repo_claude_md).map(at)],
    ['house rules', () => listDir(at(params.user_rules ?? ''), md).filter(loadsAlways)],
    ['repo rules', () => listDir(at(params.repo_rules ?? ''), md).filter(loadsAlways)],
  ];
  const loaded = attempt(() =>
    groups.map(([label, list]) => {
      const files = list().filter(exists);
      const sizes = files.map((p) => fs.readFileSync(p));
      return { label, files: files.length, bytes: sum(sizes.map((b) => b.length)), lines: sum(sizes.map(lineCount)) };
    }),
  );
  const loadedNames = `${groups.map(([l]) => l).join(', ')} (params ${['managed_claude_md', 'user_claude_md', 'repo_claude_md', 'user_rules', 'repo_rules'].map((k) => `${k} ${toList(params[k]).join(' + ')}`).join('; ')}; a rule whose frontmatter has paths is left out)`;
  const tokenSource = `state: bytes / 4 of ${loadedNames}; the MEMORY index is instructions.memory_index_tokens`;
  if (loaded.error) cnc('claude.instruction_tokens', loaded.error, tokenSource);
  else {
    const parts = loaded.filter((p) => p.bytes > 0);
    if (!parts.length) cnc('claude.instruction_tokens', 'no always-loaded file was found', tokenSource);
    else val('claude.instruction_tokens', Math.round(sum(parts.map((p) => p.bytes)) / 4), tokenSource, parts.map((p) => item(p.files > 1 ? `${p.label} (${p.files} files)` : p.label, Math.round(p.bytes / 4), 'tokens')));
  }
}

function memoryMetric(ctx) {
  const { params, at, val, cnc } = ctx;
  // The MEMORY index: only its head loads.
  const lines = Number(params.memory_head_lines);
  const bytes = Number(params.memory_head_bytes);
  const memorySource = `state: bytes / 4 of ${params.memory_index} in the ${params.projects_dir} folder ending ${params.project_match}, up to its first ${lines} lines or ${bytes} bytes, whichever comes first (the part that loads)`;
  const memory = attempt(() => {
    const dir = fs.readdirSync(at(params.projects_dir ?? '')).find((d) => d.endsWith(params.project_match));
    if (!dir) throw new Error(`no folder ends with ${params.project_match}`);
    const file = path.join(at(params.projects_dir), dir, params.memory_index);
    return exists(file) ? memoryHead(file, lines, bytes) : { bytes: 0, lines: 0 };
  });
  if (!(lines > 0 && bytes > 0)) cnc('instructions.memory_index_tokens', 'params.memory_head_lines and memory_head_bytes must be positive', memorySource);
  else if (memory.error) cnc('instructions.memory_index_tokens', memory.error, memorySource);
  else val('instructions.memory_index_tokens', Math.round(memory.bytes / 4), memorySource, [item('lines that load', memory.lines, 'lines')]);
  return memory;
}

function descriptionMetric(ctx) {
  const { params, at, val, cnc } = ctx;
  // Skill and agent listings: name, description and when_to_use.
  const sets = [
    ['project skills', at(params.repo_skills ?? ''), 'skill'],
    ['installed skills', at(params.user_skills ?? ''), 'skill'],
    ['project agents', at(params.repo_agents ?? ''), 'agent'],
  ];
  const listed = attempt(() => sets.map(([label, dir, kind]) => ({ label, found: fs.existsSync(dir), items: kind === 'skill' ? skillsIn(dir, params.skill_file) : agentsIn(dir) })));
  const descSource = `state: bytes / 4 of the name, description and when_to_use frontmatter of every ${params.skill_file} under params repo_skills (${params.repo_skills}) and user_skills (${params.user_skills}), and every agent file under repo_agents (${params.repo_agents})`;
  if (listed.error) cnc('instructions.description_tokens', listed.error, descSource);
  else if (!listed.some((s) => s.found)) cnc('instructions.description_tokens', 'no skill or agent folder was found', descSource);
  else {
    const items = listed.flatMap((s) => s.items.map((i) => ({ ...i, set: s.label })));
    val('instructions.description_tokens', Math.round(sum(items.map((i) => i.listBytes)) / 4), `${descSource}; ${items.length} read`, [
      ...listed.map((s) => item(`${s.label} (${s.items.length})`, Math.round(sum(s.items.map((i) => i.listBytes)) / 4), 'tokens')),
      ...items.sort((a, b) => b.listBytes - a.listBytes).slice(0, 10).map((i) => item(`${i.set}: ${i.name}`, Math.round(i.listBytes / 4), 'tokens')),
    ]);
  }
  return listed;
}

function linesMetric(ctx, memory) {
  const { params, at, root, home, fromRepo, val, cnc } = ctx;
  // The largest always-loaded file the repo controls, in lines: its CLAUDE.md
  // files and rules, the house rules it is the source of, and the MEMORY index
  // head. The managed and user CLAUDE.md are not the repo's; hook output is
  // blockers.hook_tokens_per_session.
  const lineSource = `state: line breaks of each always-loaded file the repo controls (params repo_claude_md, repo_rules, the user_rules whose source the repo holds by installed_from_code_os, a rule with paths left out) and the MEMORY index head; the largest`;
  const own = attempt(() =>
    [
      ...toList(params.repo_claude_md).map(at),
      ...listDir(at(params.repo_rules ?? ''), md).filter(loadsAlways),
      ...listDir(at(params.user_rules ?? ''), md).filter(loadsAlways).filter(fromRepo),
    ]
      .filter(exists)
      .map((p) => ({ label: path.relative(p.startsWith(root) ? root : home, p), lines: lineCount(fs.readFileSync(p)) })),
  );
  if (own.error || memory.error) cnc('instructions.lines_before_action', own.error ?? memory.error, lineSource);
  else {
    const files = [...own, ...(memory.lines ? [{ label: 'memory index head', lines: memory.lines }] : [])].sort((a, b) => b.lines - a.lines);
    if (!files.length) cnc('instructions.lines_before_action', 'no always-loaded file the repo controls was found', lineSource);
    else val('instructions.lines_before_action', files[0].lines, `${lineSource}; ${files.length} files`, files.map((f) => item(f.label, f.lines, 'lines')));
  }
}

function clauseMetric(ctx) {
  const { params, at, show, val, cnc } = ctx;
  // Protected clauses against the installed copies.
  const clauseFile = path.join(at(params.code_os_checkout ?? ''), params.protected_clauses ?? '');
  const clauseSource = `state: each clause of ${params.protected_clauses} in the Git Crafter checkout (params.code_os_checkout ${show(params.code_os_checkout)}) against the installed copy (params.installed_from_code_os), case and whitespace ignored as Git Crafter clause_check does`;
  const clauses = attempt(() => checkClauses(JSON.parse(fs.readFileSync(clauseFile, 'utf8')).clauses, params.installed_from_code_os ?? {}, at));
  if (clauses.error) cnc('instructions.protected_clauses_missing', clauses.error, clauseSource);
  else val('instructions.protected_clauses_missing', clauses.missing.length, `${clauseSource}; ${clauses.checked} clauses`, [item('clauses checked', clauses.checked, 'clauses'), ...clauses.missing.map((m) => item(m, 1, 'clauses'))]);
}

function unusedMetric(ctx, listed) {
  const { params, at, now, fromRepo, val, cnc } = ctx;
  const sessions = attempt(() => mainSessions(at(params.projects_dir ?? ''), params.project_match, params.subagents_dir, now.getTime()));
  // Rules, skills and agents no recent session used.
  const n = Number(params.unused_sessions);
  // A path-scoped rule the repo keeps for the account's other repos, by file
  // name in params.kept_rules, is set aside, as desktop-app.mjs sets aside
  // params.kept_kinds.
  const kept = toList(params.kept_rules);
  const unusedSource = `the last ${n} main sessions by start, each with its subagents: Skill calls and typed slash commands by name, Agent calls by subagent_type (none is general-purpose), and a paths rule when a ${toList(params.touch_tools).join(', ')} call touched a matching file under the session's folder; a rule with no paths loads every session and is left out, and so is a rule in params.kept_rules (${kept.join(', ') || 'none'})`;
  if (!(n > 0)) cnc('instructions.unused', 'params.unused_sessions must be positive', unusedSource);
  else if (sessions.error || listed.error) cnc('instructions.unused', sessions.error ?? listed.error, unusedSource);
  else if (!sessions.length) cnc('instructions.unused', `no main session transcript in a folder naming ${params.project_match}`, unusedSource);
  else {
    const rules = attempt(() =>
      [
        ...listDir(at(params.user_rules ?? ''), md).filter(fromRepo),
        ...listDir(at(params.repo_rules ?? ''), md),
      ].map((p) => ({ name: path.basename(p), globs: rulePaths(p) })).filter((r) => r.globs.length && !kept.includes(r.name)),
    );
    const use = attempt(() => usesIn(sessions.slice(0, n), new Set(toList(params.touch_tools))));
    if (rules.error || use.error) cnc('instructions.unused', rules.error ?? use.error, unusedSource);
    else {
      const items = [
        ...listed.filter((s) => s.label.endsWith('skills')).flatMap((s) => s.items.filter((i) => s.label !== 'installed skills' || fromRepo(i.file)).map((i) => ({ label: `skill: ${i.name}`, uses: (use.skills.get(i.name) ?? 0) }))),
        ...listed.filter((s) => s.label.endsWith('agents')).flatMap((s) => s.items.map((i) => ({ label: `agent: ${i.name}`, uses: use.agents.get(i.name) ?? 0 }))),
        ...rules.map((r) => {
          const res = r.globs.map(globRegex);
          return { label: `rule: ${r.name}`, uses: use.touched.filter((f) => res.some((re) => re.test(f))).length };
        }),
      ];
      const unused = items.filter((i) => i.uses === 0);
      val('instructions.unused', unused.length, `${unusedSource}; ${Math.min(n, sessions.length)} sessions read, from ${iso(sessions[Math.min(n, sessions.length) - 1].start)} UTC; ${items.length} items`, [
        ...unused.map((i) => item(i.label, 0, 'uses')),
        ...items.filter((i) => i.uses > 0).sort((a, b) => b.uses - a.uses).map((i) => item(i.label, i.uses, 'uses')),
      ]);
    }
  }
}

function all(reason, source) {
  return Object.fromEntries(metricIds.map((id) => [id, { could_not_check: reason, source }]));
}
