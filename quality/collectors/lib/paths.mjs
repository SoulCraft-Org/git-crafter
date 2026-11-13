// Where a repo and a local session's files are: shared by the GitHub tabs and
// the Claude tabs, so neither imports the other's folder.
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const gitOut = async (cmd, args) => (await run(cmd, args)).stdout;

// The project folder Claude Code keeps a checkout's sessions in is the
// checkout's absolute path with every character other than a letter or digit
// turned into a dash (observed in ~/.claude/projects; the docs name the folder,
// not the rule). A worktree's folder adds its own path to the main checkout's,
// so the main checkout's name matches both.
export function projectMatch(root) {
  const main = path.resolve(root).replace(/\/\.claude\/worktrees\/[^/]+.*$/, '');
  return main.replace(/[^A-Za-z0-9]/g, '-');
}

// The managed policy CLAUDE.md, by platform (code.claude.com/docs/en/memory,
// read 2026-11-03).
export function managedClaudeMd(platform = process.platform) {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/CLAUDE.md';
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode\\CLAUDE.md';
  return '/etc/claude-code/CLAUDE.md';
}

// GitHub owner and name from a remote URL, or null.
export function remoteRepo(url) {
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(url).trim());
  return m ? { owner: m[1], name: m[2] } : null;
}

// owner/name of the repo being measured: params.repo, else the one GitHub
// Actions names (GITHUB_REPOSITORY), else the root's origin remote; '' when
// none answers.
export async function ownRepo(root, params = {}, exec = gitOut) {
  if (params.repo) return String(params.repo);
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    const r = remoteRepo(await exec('git', ['-C', root, 'remote', 'get-url', 'origin']));
    return r ? `${r.owner}/${r.name}` : '';
  } catch {
    return '';
  }
}

// A path param: "~/" is under home, an absolute path is itself, any other is
// under the repo root (the rule instructions.mjs's params follow).
export function resolvePath(p, { home = os.homedir(), root = '.' } = {}) {
  const s = String(p ?? '');
  return s.startsWith('~/') ? path.join(home, s.slice(2)) : path.isAbsolute(s) ? s : path.join(root, s);
}
// Where Claude Code keeps session transcripts, unless params.projects_dir says otherwise.
export const PROJECTS_DIR = '~/.claude/projects';
