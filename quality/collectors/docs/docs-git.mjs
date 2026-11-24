// Git reads for the Documentation collector (docs.mjs).
import { spawnSync } from 'node:child_process';
import { bare, firstLine, realpath } from './docs-util.mjs';
import { withoutComments } from './docs-comments.mjs';

// A git hook exports GIT_DIR and friends, which would override -C root.
const GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|PREFIX)$/.test(k)));

function git(root, args, input) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', input, env: GIT_ENV, maxBuffer: 16 << 20 });
  if (r.error) return { status: null, out: '', err: r.error.message };
  return { status: r.status, out: r.stdout || '', err: r.stderr || '' };
}

// Root is the top of a git work tree: enough for git check-ignore.
export function gitTree(root) {
  const top = git(root, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) return { ok: false, reason: `${root} is not a git work tree (${firstLine(top.err) || 'git missing'})` };
  if (realpath(top.out.trim()) !== realpath(root)) return { ok: false, reason: `${root} is inside a git work tree but is not its root` };
  return { ok: true };
}

// The full history as well: what doc lag and dated claims compare against.
// Consolidation needs only its last merged PRs, so it checks on its own.
export function gitHistory(root, tree) {
  if (!tree.ok) return tree;
  if (git(root, ['rev-parse', '--is-shallow-repository']).out.trim() === 'true') {
    return { ok: false, shallow: true, reason: 'shallow clone; check out with fetch-depth: 0' };
  }
  return { ok: true };
}

// The paths git ignores, from git check-ignore.
export function gitIgnored(root, paths) {
  const asked = [...new Set(paths.flatMap((p) => [bare(p), `${bare(p)}/`]))];
  const r = git(root, ['check-ignore', '--stdin'], `${asked.join('\n')}\n`);
  if (r.status !== 0 && r.status !== 1) return { problem: `git check-ignore failed: ${firstLine(r.err)}` };
  return { set: new Set(r.out.split('\n').filter(Boolean).map(bare)) };
}

// The tracked files git pathspecs match together; none when git refuses them.
export function trackedFiles(root, ...pathspecs) {
  const r = git(root, ['ls-files', '-z', '--', ...pathspecs]);
  return r.status === 0 ? r.out.split('\0').filter(Boolean) : [];
}

// The epoch seconds of the newest commit touching the pathspecs, or null.
export function lastCommit(root, pathspecs) {
  const r = git(root, ['log', '-1', '--format=%ct', '--', ...pathspecs]);
  const ts = Number(r.out.trim());
  return r.status === 0 && ts > 0 ? ts : null;
}

// The YYYY-MM-DD of the newest commit touching the pathspecs, or null.
export function lastCommitDay(root, pathspecs) {
  const r = git(root, ['log', '-1', '--format=%cd', '--date=short', '--', ...pathspecs]);
  const day = r.out.trim();
  return r.status === 0 && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

// The newest commits looked through for one that changes more than comments.
const CODE_SCAN = 200;

// A file's text at a commit, or null when git cannot show it.
function showAt(root, rev, file) {
  const r = git(root, ['show', `${rev}:${file}`]);
  return r.status === 0 ? r.out : null;
}

// Whether a commit changes only comments among the pathspecs, against its first parent (or the empty tree).
function onlyComments(root, sha, parent, pathspecs) {
  const d = git(root, ['diff', '--no-renames', '--name-status', '-z', parent, sha, '--', ...pathspecs]);
  const f = d.out.split('\0').filter(Boolean);
  if (d.status !== 0 || !f.length) return false;
  for (let i = 0; i + 1 < f.length; i += 2) {
    const [status, file] = [f[i], f[i + 1]];
    const before = status === 'A' ? '' : showAt(root, parent, file);
    const after = status === 'D' ? '' : showAt(root, sha, file);
    if (before === null || after === null) return false;
    const [a, b] = [withoutComments(file, before), withoutComments(file, after)];
    if (a === null || a !== b) return false;
  }
  return true;
}

// The epoch seconds of the newest commit touching the pathspecs that changes more than comments, or null. A commit
// whose every changed file differs only in comments is passed over; when all of the newest CODE_SCAN are, the oldest of them.
export function lastCodeCommit(root, pathspecs) {
  const log = git(root, ['log', `-${CODE_SCAN}`, '--format=%H %ct %P', '--', ...pathspecs]);
  if (log.status !== 0) return null;
  const empty = git(root, ['hash-object', '-t', 'tree', '/dev/null']).out.trim();
  let oldest = null;
  for (const line of log.out.split('\n').filter(Boolean)) {
    const [sha, ct, parent = empty] = line.split(' ');
    const ts = Number(ct);
    if (!(ts > 0)) continue;
    oldest = ts;
    if (!onlyComments(root, sha, parent, pathspecs)) return ts;
  }
  return oldest;
}
