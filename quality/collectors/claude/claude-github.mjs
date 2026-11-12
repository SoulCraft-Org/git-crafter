// What the Claude collector reads from GitHub: each linked PR, its first
// push's checks, reverts and bugs naming it (claude.mjs).

import { causes, PULL_FIELDS, reverts as findReverts } from '../github/github.mjs';
import { firstLine, TEMPLATE } from './claude-lib.mjs';

const PR_CHUNK = 50;
const GREEN = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
// A cancelled check gave no verdict (a later push or a skipped dependency
// stopped it), so it is neither green nor red.
const RED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const CANCELLED = 'CANCELLED';
const SHA = /^[0-9a-f]{40}$/;
const TEST_FILE = /(^|\/)(__tests__|tests?|e2e|fixtures)\/|[._-](test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|sh)$|selftest/;
const CONFIG_FILE = /(^|\/)[^/]*\.config\.[cm]?[jt]s$/;
const CODE_FILE = /\.(astro|[cm]?[jt]sx?|py|sh)$/;
const REVERT_SEARCH = 'Revert in:title';

// A PR's author is a bot when GraphQL types it Bot, the test the Pull requests tab uses.
const isBot = (a) => !a || a.__typename === 'Bot';

// The session that linked a PR first is the one credited with opening it.
function prLinks(sessions) {
  const links = new Map();
  for (const [sessionId, s] of sessions) {
    for (const [key, at] of s.prs) {
      const prev = links.get(key);
      if (!prev || at < prev.linkedAt) {
        const [repo, n] = key.split('#');
        links.set(key, { key, repo, number: Number(n), sessionId, linkedAt: at });
      }
    }
  }
  return [...links.values()];
}

// The first push is the last commit made before the PR opened.
function firstPushSha(pr) {
  const opened = Date.parse(pr.createdAt);
  const before = pr.commitList.filter((c) => Date.parse(c.committedDate) <= opened);
  return (before.at(-1) ?? pr.commitList[0])?.oid;
}

// CheckRun nodes carry `conclusion`; StatusContext nodes carry `state`. Checks
// in notCode read the PR rather than run its code, so they give no verdict.
export function classifyChecks(contexts, notCode = new Set(TEMPLATE.not_code_checks ?? [])) {
  const counted = (contexts ?? []).filter((c) => !notCode.has(nameOf(c)));
  if (!counted.length) return { state: 'none', failed: [] };
  const failed = [];
  let pending = false;
  let cancelled = false;
  for (const c of counted) {
    const result = c.conclusion || c.state;
    if (RED.has(result)) failed.push(nameOf(c) || 'unnamed');
    else if (result === CANCELLED) cancelled = true;
    else if (!GREEN.has(result)) pending = true;
  }
  return { state: verdict(failed, pending, cancelled), failed };
}

const nameOf = (c) => c.name || c.context;
const verdict = (failed, pending, cancelled) => (failed.length ? 'red' : pending ? 'pending' : cancelled ? 'cancelled' : 'green');

// gh exits 1 when a GraphQL response carries errors, yet still prints the whole
// response, data included, on stdout (checked 2026-11-03), so keep that body.
async function graphql(gh, query) {
  let out;
  try {
    out = await gh(['api', 'graphql', '-f', `query=${query}`]);
  } catch (err) {
    out = err?.stdout;
    if (!out) throw err;
  }
  try {
    return JSON.parse(out);
  } catch {
    throw new Error('gh api graphql returned no JSON');
  }
}

async function commitContexts(repo, shas, gh) {
  const [owner, name] = repo.split('/');
  const out = new Map();
  for (let i = 0; i < shas.length; i += PR_CHUNK) {
    const chunk = shas.slice(i, i + PR_CHUNK);
    const fields = chunk
      .map(
        (sha, j) =>
          `c${j}: object(oid: "${sha}") { ... on Commit { statusCheckRollup { contexts(first: 100) { nodes { __typename ... on CheckRun { name conclusion status } ... on StatusContext { context state } } } } } }`,
      )
      .join(' ');
    const body = await graphql(gh, `query { repository(owner: "${owner}", name: "${name}") { ${fields} } }`);
    if (body.errors?.length) throw new Error(body.errors[0].message);
    chunk.forEach((sha, j) => out.set(sha, body.data?.repository?.[`c${j}`]?.statusCheckRollup?.contexts?.nodes ?? []));
  }
  return out;
}

// What the Claude tab reads of a PR: the fields github.mjs's shared functions
// read (PULL_FIELDS), plus its state, its author's type, every commit and the
// checks on its head.
const CLAUDE_PULL_FIELDS = `${PULL_FIELDS}
        state author { __typename }
        commits(first: 100) { nodes { commit { oid committedDate } } }
        headCommit: commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { __typename ... on CheckRun { name conclusion status } ... on StatusContext { context state } } } } } } }`;

// Reads a repo's linked PRs, PR_CHUNK to one GraphQL query instead of one gh
// call each. A PR GitHub cannot find is `missing`. Any other error counts its
// PRs as `failed` and keeps the first reason.
async function readPulls(repo, numbers, gh) {
  const [owner, name] = repo.split('/');
  const all = { found: new Map(), missing: [], failed: 0, reason: null };
  for (let i = 0; i < numbers.length; i += PR_CHUNK) {
    const part = await readChunk(owner, name, numbers.slice(i, i + PR_CHUNK), gh);
    for (const [n, node] of part.found) all.found.set(n, node);
    all.missing.push(...part.missing);
    all.failed += part.failed;
    all.reason ??= part.reason;
  }
  return all;
}

async function readChunk(owner, name, chunk, gh) {
  const out = { found: new Map(), missing: [], failed: 0, reason: null };
  const aliases = chunk.map((n) => `p${n}: pullRequest(number: ${n}) { ${CLAUDE_PULL_FIELDS} }`).join(' ');
  let body;
  try {
    body = await graphql(gh, `query { repository(owner: "${owner}", name: "${name}") { ${aliases} } }`);
  } catch (err) {
    return { ...out, failed: chunk.length, reason: firstLine(err) };
  }
  // Only a NOT_FOUND on the PR itself means GitHub has no such PR. An error
  // above the PRs, such as a repository NOT_FOUND for a private repo the gh
  // login cannot see, says nothing about them, so it fails them all.
  const errors = body.errors ?? [];
  const general = errors.find((e) => !e.path?.[1]);
  for (const n of chunk) classifyPull(n, { body, errors, general }, out);
  return out;
}

function classifyPull(n, { body, errors, general }, out) {
  const node = body.data?.repository?.[`p${n}`];
  const own = errors.find((e) => e.path?.[1] === `p${n}`);
  if (general || (own && own.type !== 'NOT_FOUND')) return unread(out, String((general ?? own).message ?? (general ?? own).type).slice(0, 160));
  if (node) out.found.set(n, node);
  else if (own) out.missing.push(n);
  else unread(out, 'gh returned no data for a PR');
}

function unread(out, reason) {
  out.failed += 1;
  out.reason ??= reason;
}

// The one place issue text is read: only the PR numbers it names as the cause
// leave (causes() in github.mjs, as the Blockers tab reads them); a PR the bug
// mentions for context is no cause.
function bugRefs(issue, repo) {
  const text = `${issue.title ?? ''}\n${issue.body ?? ''}`;
  return { number: issue.number, createdAt: Date.parse(issue.createdAt), refs: causes(text, repo) };
}

// One PR as the metrics read it: the GraphQL node, which github.mjs's shared
// functions take as is, plus its commits and head checks unwrapped, its
// reviewed lines and its files' roles (from paths and line counts only).
function toPr(node, link) {
  const files = node.files?.nodes ?? [];
  return {
    ...node,
    repo: link.repo,
    sessionId: link.sessionId,
    commitList: (node.commits?.nodes ?? []).map((n) => n.commit),
    headChecks: node.headCommit?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [],
    code: files.some((f) => CODE_FILE.test(f.path) && !TEST_FILE.test(f.path) && !CONFIG_FILE.test(f.path)),
    tests: files.some((f) => TEST_FILE.test(f.path)),
  };
}

// The PRs the sessions link to, read from GitHub and joined to the sessions.
export async function joinGithub(sessions, gh, notCode) {
  const links = prLinks(sessions);
  const read = await readLinked(links, gh);
  // An unread PR would bias every PR metric, so none reads. Only a PR GitHub
  // does not have is skipped, and a detail row counts it.
  if (read.failed) return { error: `gh could not read ${read.failed} of ${links.length} linked PRs (${read.reason})`, linked: links.length };
  const { prs, missing } = read;
  // Only PRs opened after their session started were opened by it, and never a bot's.
  const opened = prs.filter((p) => !isBot(p.author) && Date.parse(p.createdAt) >= sessions.get(p.sessionId).start);
  const firstPush = await firstPushStates(opened, gh, notCode);
  const { reverted, bugs } = await revertsAndBugs(opened, gh);
  return { error: null, linked: links.length, read: prs.length, missing, opened, firstPush, reverted, bugs };
}

async function readLinked(links, gh) {
  const byRepo = new Map();
  for (const l of links) byRepo.set(l.repo, [...(byRepo.get(l.repo) ?? []), l]);
  const out = { prs: [], missing: 0, failed: 0, reason: null };
  for (const [repo, list] of byRepo) {
    const read = await readPulls(repo, list.map((l) => l.number), gh);
    out.missing += read.missing.length;
    out.failed += read.failed;
    out.reason ??= read.reason;
    for (const l of list) if (read.found.has(l.number)) out.prs.push(toPr(read.found.get(l.number), l));
  }
  return out;
}

// Each opened PR's checks on its first push: the head's when nothing came later,
// else a GraphQL lookup of that earlier commit.
async function firstPushStates(opened, gh, notCode) {
  const firstPush = { error: null, byPr: new Map() };
  const later = new Map();
  for (const p of opened) {
    const sha = firstPushSha(p);
    if (sha && sha !== p.headRefOid && SHA.test(sha)) later.set(p.repo, [...(later.get(p.repo) ?? []), [p, sha]]);
    else firstPush.byPr.set(p, classifyChecks(p.headChecks, notCode));
  }
  for (const [repo, pairs] of later) {
    try {
      const contexts = await commitContexts(repo, pairs.map(([, sha]) => sha), gh);
      for (const [p, sha] of pairs) firstPush.byPr.set(p, classifyChecks(contexts.get(sha), notCode));
    } catch (err) {
      firstPush.error = `gh api graphql failed (${firstLine(err)})`;
    }
  }
  return firstPush;
}

// Reverts by github.mjs's matcher: a merged PR titled Revert "<title>".
// byRepo maps each reverted PR's number to when its first revert merged.
async function revertsAndBugs(opened, gh) {
  const mergedRepos = new Set(opened.filter((p) => p.state === 'MERGED').map((p) => p.repo));
  const reverted = { error: null, byRepo: new Map() };
  const bugs = { error: null, byRepo: new Map() };
  for (const repo of mergedRepos) {
    try {
      reverted.byRepo.set(repo, await revertTimes(repo, opened, gh));
    } catch (err) {
      reverted.error = `gh pr list failed for ${repo} (${firstLine(err)})`;
    }
    try {
      const out = await gh(['issue', 'list', '-R', repo, '--type', 'Bug', '--state', 'all', '--json', 'number,title,body,createdAt', '--limit', '1000']);
      bugs.byRepo.set(repo, JSON.parse(out).map((issue) => bugRefs(issue, repo)));
    } catch (err) {
      bugs.error = `gh issue list failed for ${repo} (${firstLine(err)})`;
    }
  }
  return { reverted, bugs };
}

async function revertTimes(repo, opened, gh) {
  const out = await gh(['pr', 'list', '-R', repo, '--state', 'merged', '--search', REVERT_SEARCH, '--json', 'number,title,mergedAt', '--limit', '200']);
  const own = opened.filter((p) => p.repo === repo && p.state === 'MERGED');
  const when = new Map();
  for (const r of findReverts([...JSON.parse(out), ...own])) {
    const at = Date.parse(r.pull.mergedAt);
    if (r.original && Number.isFinite(at) && !(when.get(r.original.number) <= at)) when.set(r.original.number, at);
  }
  return when;
}
