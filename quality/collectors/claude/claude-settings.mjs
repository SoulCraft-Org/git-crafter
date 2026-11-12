// Claude settings tab collector: do Claude Code's settings let work run
// without stopping, and does every rule in them do what it says?
//
//   Quality      claude_settings.valid: problems in the settings files the
//                repo commits (parse, unknown keys, rule shapes the docs say
//                Claude Code skips or ignores)
//   Speed        claude_settings.prompts_per_100_calls: tool calls that
//                waited for a person, from session transcripts
//   Consumption  blockers.hook_tokens_per_session (blockers.mjs reads it;
//                hooks are a settings key, so it shows on this tab)
//
// A prompt's record: Claude Code writes permissionDecision on each tool
// result ({ decision, source, reasonCode | reasonType }). source "config"
// means a rule, the mode or the classifier decided; a source starting "user"
// means a person answered a prompt (observed in ~/.claude/projects, Claude
// Code 2.1.317, 2026-11-04; the docs do not describe the field).
//
// Privacy: transcripts are read in `local` mode only. Of each record only the
// tool name, timestamp and permissionDecision are kept; prompts, commands and
// results never leave this module.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROJECTS_DIR, projectMatch, resolvePath } from './claude.mjs';
import { redact } from '../lib/redact.mjs';

export const area = 'claude_settings';

const TARGETS = JSON.parse(fs.readFileSync(new URL('../../targets/claude-settings.json', import.meta.url), 'utf8'));
export const metricIds = TARGETS.map((t) => t.id);
const TEMPLATE = Object.assign({}, ...TARGETS.map((t) => t.params ?? {}));
const LAST_CALLS = 1000;
const PER = 100;
const CI_REASON = 'transcripts live on the machine that ran the sessions; refreshed by a --local collect there';
// Tools whose prompt is the point: a plan to approve, a question to answer.
const ASKS_BY_DESIGN = new Set(['ExitPlanMode', 'AskUserQuestion']);

// The settings index, code.claude.com/docs/en/settings-reference, read 2026-11-04.
export const KNOWN_KEYS = new Set(['$schema', 'advisorModel', 'agent', 'agentPushNotifEnabled', 'allowAllClaudeAiMcps', 'allowClaudeInChromeWithManagedMcp', 'allowedChannelPlugins', 'allowedHttpHookUrls', 'allowedMcpServers', 'allowedProviders', 'allowManagedHooksOnly', 'allowManagedMcpServersOnly', 'allowManagedPermissionRulesOnly', 'alwaysThinkingEnabled', 'apiKeyHelper', 'askUserQuestionTimeout', 'appendPlugins', 'attribution', 'autoCompactEnabled', 'autoCompactWindow', 'autoConnectIde', 'autoContinueAtUsageLimit', 'autoInstallIdeExtension', 'autoMemoryDirectory', 'autoMemoryEnabled', 'autoMode', 'autoScrollEnabled', 'autoUpdatesChannel', 'availableModels', 'availableModelsMatch', 'awaySummaryEnabled', 'awsAuthRefresh', 'awsCredentialExport', 'axScreenReader', 'bashEditDiffEnabled', 'bashOutputMaxChars', 'blockedMarketplaces', 'browserExternalPageTools', 'channelsEnabled', 'claudeInChromeDefaultEnabled', 'claudeMd', 'claudeMdExcludes', 'cleanupPeriodDays', 'companyAnnouncements', 'copyFullResponse', 'copyOnSelect', 'crossSessionInbound', 'defaultShell', 'defaultToAgentsView', 'deniedMcpServers', 'deniedModels', 'desktopSessionCleanupPeriodDays', 'dialogExpiry', 'diffTool', 'disableAgentView', 'disableAllHooks', 'disableArtifact', 'disableAutoMode', 'disableBrowserExternalNavigation', 'disableBundledSkills', 'disableClaudeAiConnectors', 'disableCommandPluginSources', 'disableDeepLinkRegistration', 'disableDesktopLocalSessions', 'disabledMcpjsonServers', 'disableMobileSimulatorTools', 'disableRemoteControl', 'disableSideloadFlags', 'disableSkillShellExecution', 'disableWorkflows', 'editorMode', 'effortLevel', 'emojiCompletionEnabled', 'enableAllProjectMcpServers', 'enableArtifact', 'enabledMcpjsonServers', 'enabledPlugins', 'enableWorkflows', 'enforceAvailableModels', 'env', 'externalEditorContext', 'extraKnownMarketplaces', 'fallbackModel', 'fastMode', 'fastModePerSessionOptIn', 'feedbackDrafts', 'feedbackSurveyRate', 'fileCheckpointingEnabled', 'fileSuggestion', 'footerLinksRegexes', 'forceLoginGatewayUrl', 'forceLoginMethod', 'forceLoginOrgUUID', 'forceRemoteSettingsRefresh', 'gatewayInternalNetworks', 'gcpAuthRefresh', 'hooks', 'httpHookAllowedEnvVars', 'idleCompaction', 'includeCoAuthoredBy', 'includeGitInstructions', 'inputNeededNotifEnabled', 'isolatePeerMachines', 'keybindingFlavor', 'language', 'leftArrowOpensAgents', 'managedMcpServers', 'managedSourcesBehavior', 'maxEffortLevel', 'maxProseWidth', 'minimumVersion', 'model', 'modelOverrides', 'modelPicker', 'modelPricing', 'modelSettings', 'otelHeadersHelper', 'outputStyle', 'parentSettingsBehavior', 'permissionExplainerEnabled', 'permissions', 'plansDirectory', 'pluginConfigs', 'pluginSuggestionMarketplaces', 'pluginTrustMessage', 'policyHelper', 'preferredNotifChannel', 'prefersReducedMotion', 'prependPlugins', 'processWrapper', 'promptCacheTtl', 'promptSuggestionEnabled', 'prStatusFooterEnabled', 'prUrlTemplate', 'remoteControlAtStartup', 'requiredMaximumVersion', 'requiredMinimumVersion', 'respectGitignore', 'respondToBashCommands', 'sandbox', 'sshConfigs', 'sshHostAllowlist', 'sshHostCommands', 'statusLine', 'strictKnownMarketplaces', 'strictPluginOnlyCustomization', 'subagentPromptCacheTtl', 'subagentStatusLine', 'switchModelsOnFlag', 'syncClaudeAiPlugins', 'syncClaudeAiSkills', 'syntaxHighlightingDisabled', 'taskOutputMaxChars', 'teammateDefaultModel', 'teammateMode', 'terminalProgressBarEnabled', 'terminalTitleFromRename', 'theme', 'timeFormat', 'timeZone', 'tui', 'ultracode', 'useAutoModeDuringPlan', 'verbose', 'viewMode', 'vimInsertModeRemaps', 'voice', 'voiceEnabled', 'wheelScrollAccelerationEnabled', 'workflowKeywordTriggerEnabled', 'workflowSizeGuideline', 'worktree', 'wslInheritsWindowsSettings']);
export const PERMISSION_KEYS = new Set(['additionalDirectories', 'allow', 'ask', 'blockReadsOutsideWorkingDirectories', 'blockWritesOutsideWorkingDirectories', 'defaultMode', 'deny', 'disableBypassPermissionsMode']);
// code.claude.com/docs/en/permission-modes, read 2026-11-04; manual is the CLI's alias for default.
const MODES = new Set(['default', 'manual', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']);
// "auto and bypassPermissions don't take effect from project or local settings" (docs/en/settings).
const USER_ONLY_MODES = new Set(['auto', 'bypassPermissions']);
// The primary content field a Bash(command:...)-style rule may not match (docs/en/permissions).
const PRIMARY = { Bash: 'command', PowerShell: 'command', Read: 'file_path', Edit: 'file_path', Write: 'file_path', Grep: 'path', Glob: 'path', NotebookEdit: 'notebook_path', WebFetch: 'url' };

// Why Claude Code skips or ignores a permission rule, or null when it takes
// it. Each case is a sentence of code.claude.com/docs/en/permissions, read
// 2026-11-04. list is allow, ask or deny.
export function ruleProblem(rule, list) {
  if (typeof rule !== 'string' || !rule.trim()) return 'not a rule string';
  const m = /^([^()\s]+)(?:\((.*)\))?$/s.exec(rule);
  if (!m) return 'not Tool or Tool(specifier)';
  return specifierProblem(m[1], m[2], list);
}

function specifierProblem(tool, spec, list) {
  if (tool.startsWith('mcp__') && spec !== undefined) return 'an mcp__ rule with parentheses is skipped';
  if (list === 'allow' && tool.includes('*') && !/^mcp__[^*_]+(?:_[^*_]+)*__/.test(tool)) return 'an allow glob needs a literal mcp__<server>__ prefix, or it is skipped';
  return spec === undefined ? null : bodyProblem(tool, spec);
}

function bodyProblem(tool, spec) {
  if (PRIMARY[tool] && spec.startsWith(`${PRIMARY[tool]}:`)) return `${tool}(${PRIMARY[tool]}:...) is ignored; write ${tool}(...)`;
  if ((tool === 'Bash' || tool === 'PowerShell') && /:\*./.test(spec)) return ':* is a wildcard only at the end; elsewhere the colon is literal';
  return null;
}

// Every problem in one parsed settings object, as { where, problem }.
export function settingsProblems(json, extraKeys = []) {
  if (!isObject(json)) return [{ where: '(file)', problem: 'not a JSON object' }];
  const known = new Set([...KNOWN_KEYS, ...extraKeys]);
  const out = Object.keys(json).filter((k) => !known.has(k)).map((k) => ({ where: k, problem: 'unknown key' }));
  const perms = json.permissions;
  if (perms === undefined) return out;
  if (!isObject(perms)) return [...out, { where: 'permissions', problem: 'not an object' }];
  return [...out, ...permissionProblems(perms)];
}

const isObject = (x) => Boolean(x) && typeof x === 'object' && !Array.isArray(x);

function permissionProblems(perms) {
  const out = Object.keys(perms).filter((k) => !PERMISSION_KEYS.has(k)).map((k) => ({ where: `permissions.${k}`, problem: 'unknown key' }));
  const mode = perms.defaultMode;
  if (mode !== undefined && !MODES.has(mode)) out.push({ where: 'permissions.defaultMode', problem: `unknown mode ${JSON.stringify(mode)}` });
  else if (USER_ONLY_MODES.has(mode)) out.push({ where: 'permissions.defaultMode', problem: `${mode} takes no effect from a project file` });
  for (const list of ['allow', 'ask', 'deny']) out.push(...listProblems(perms[list], list));
  return out;
}

function listProblems(rules, list) {
  if (rules === undefined) return [];
  if (!Array.isArray(rules)) return [{ where: `permissions.${list}`, problem: 'not a list' }];
  return rules.flatMap((rule) => {
    const problem = ruleProblem(rule, list);
    return problem ? [{ where: `permissions.${list}: ${rule}`, problem }] : [];
  });
}

function validMetric(root, params, def) {
  const files = (params.files ?? TEMPLATE.files).filter((f) => fs.existsSync(path.join(root, f)));
  const source = def?.source ?? 'settings files';
  const problems = [];
  for (const f of files) {
    let json;
    try {
      json = JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
    } catch (err) {
      problems.push({ file: f, where: '(file)', problem: `does not parse: ${String(err.message).split('\n')[0].slice(0, 80)}` });
      continue;
    }
    for (const p of settingsProblems(json, params.extra_keys ?? [])) problems.push({ file: f, ...p });
  }
  const detail = problems.length
    ? problems.slice(0, 20).map((p) => ({ label: `${p.file} ${p.where}: ${p.problem}`, value: 1, unit: '' }))
    : files.map((f) => ({ label: `${f}: no problem`, value: 0, unit: '' }));
  return { value: problems.length, source: `${source}; ${files.length ? files.join(', ') : 'no settings file in the repo'}`, ...(detail.length ? { detail } : {}) };
}

// Every *.jsonl under the project folders whose name contains match.
function transcriptFiles(dir, match) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory() && e.name.includes(match)) walk(path.join(dir, e.name));
  return out;
}

// The tool results that carry a permissionDecision, as { at, tool, prompt, reason }.
export function decisions(text) {
  const tools = new Map();
  const out = [];
  for (const line of text.split('\n')) {
    const r = decisionLine(line, tools);
    if (r) out.push(r);
  }
  return out;
}

// One transcript line: remembers the tool calls it makes, and returns the
// decision it carries, if any.
function decisionLine(line, tools) {
  if (!line.includes('"tool_use"') && !line.includes('"permissionDecision"')) return null;
  const r = parseJson(line);
  if (!r) return null;
  const content = Array.isArray(r.message?.content) ? r.message.content : [];
  for (const c of content) if (c?.type === 'tool_use') tools.set(c.id, c.name);
  const p = r.permissionDecision;
  if (!p || typeof p !== 'object') return null;
  return decisionOf(r, p, tools.get(content.find((c) => c?.type === 'tool_result')?.tool_use_id) ?? '');
}

function decisionOf(r, p, tool) {
  const byUser = /^user/.test(String(p.source ?? ''));
  return { at: Date.parse(r.timestamp), tool, prompt: byUser && !ASKS_BY_DESIGN.has(tool), reason: String(p.reasonCode ?? p.reasonType ?? 'unknown') };
}

function parseJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function promptsMetric(root, params, def, { home, projectsDir, now }) {
  const match = String(params.project_match || projectMatch(root));
  const dir = projectsDir ?? resolvePath(params.projects_dir || PROJECTS_DIR, { home, root });
  const where = `${params.projects_dir || PROJECTS_DIR}/*${match}*/**/*.jsonl`;
  const source = `${where}: ${def?.source ?? 'permissionDecision of each tool result'}`;
  if (!/[A-Za-z0-9]/.test(match)) return { could_not_check: `the project match "${match}" would read every project folder; set params.project_match`, source };
  let all;
  try {
    all = transcriptFiles(dir, match).flatMap((f) => decisions(fs.readFileSync(f, 'utf8')));
  } catch (err) {
    return { could_not_check: `could not read ${where} (${err.code ?? err.message})`, source };
  }
  const calls = all.filter((d) => Number.isFinite(d.at) && d.at <= now).sort((a, b) => b.at - a.at).slice(0, LAST_CALLS);
  if (!calls.length) return { could_not_check: `no tool result with a permissionDecision in ${where}`, source };
  const prompts = calls.filter((d) => d.prompt);
  const span = `${calls.length} read, ${new Date(calls.at(-1).at).toISOString().slice(0, 16)} to ${new Date(calls[0].at).toISOString().slice(0, 16)} UTC`;
  return { value: Math.round((PER * 100 * prompts.length) / calls.length) / 100, source: `${source}; ${span}`, detail: promptDetail(prompts, calls.length) };
}

// The most common reasons a call prompted, then how many calls were read.
function promptDetail(prompts, read) {
  const byReason = new Map();
  for (const d of prompts) byReason.set(d.reason, (byReason.get(d.reason) ?? 0) + 1);
  const detail = [...byReason].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([label, value]) => ({ label, value, unit: 'prompts' }));
  detail.push({ label: 'tool calls read', value: read, unit: 'calls' });
  return detail;
}

// Every metric of this tab, with each home path and account name taken out
// of the text (redact.mjs).
export async function collect(opts = {}) {
  return redact(await gather(opts), opts.home);
}

async function gather({ root = '.', mode, params = TEMPLATE, targets = TARGETS, home = os.homedir(), projectsDir, now = new Date() } = {}) {
  const def = (id) => targets.find((t) => t.id === id) ?? TARGETS.find((t) => t.id === id);
  const p = { ...TEMPLATE, ...params };
  const out = { 'claude_settings.valid': validMetric(root, p, def('claude_settings.valid')) };
  const id = 'claude_settings.prompts_per_100_calls';
  out[id] = mode === 'local' ? promptsMetric(root, p, def(id), { home, projectsDir, now: now.getTime() }) : { could_not_check: CI_REASON, source: def(id).source };
  return out;
}
