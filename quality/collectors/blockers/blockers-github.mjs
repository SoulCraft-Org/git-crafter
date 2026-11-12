// The GitHub half of the Blockers collector: merged PRs, the revert breaker and the review rounds (blockers.mjs).

import path from 'node:path';
import { causes, prRefs } from '../github/github.mjs';
import { LAST_PRS, MAX_PAGES, MIN, PR_PAGE, RED, TEMPLATE } from './blockers-core.mjs';

// ---------------------------------------------------------------- github

// gh exits 1 when a GraphQL response carries errors, yet still prints it whole
// on stdout, so keep that body and let the caller read its errors.
export async function graphql(gh, query) {
  let out;
  try {
    out = await gh(['api', 'graphql', '-f', `query=${query}`]);
  } catch (err) {
    out = err?.stdout;
    if (!out) throw err;
  }
  return JSON.parse(out);
}

const PR_FIELDS = `number title mergedAt updatedAt headRefOid files(first: 100) { nodes { path } }
  reviews(first: 50) { nodes { author { login } submittedAt commit { oid } } }
  commits(last: 30) { nodes { commit { oid committedDate checkSuites(first: 10) { nodes { createdAt checkRuns(first: 30, filterBy: {checkType: ALL}) { nodes { name completedAt conclusion } } } } } } }`;

// The last LAST_PRS + 1 merged PRs, newest merge first; the extra one marks
// where the last LAST_PRS began. Pages come newest update first, PR_PAGE to a
// query. A PR merged after time T was updated after T too, so the walk stops
// at the first page that ends before the (LAST_PRS + 1)th newest merge so far.
export async function readMerged(repo, gh, now) {
  const [owner, name] = repo.split('/');
  const byNumber = new Map();
  let prs = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const conn = await mergedPage(gh, owner, name, after);
    for (const pr of conn.nodes ?? []) if (Date.parse(pr.mergedAt) <= now) byNumber.set(pr.number, pr);
    prs = [...byNumber.values()].sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt)).slice(0, LAST_PRS + 1);
    const floor = prs.length > LAST_PRS ? Date.parse(prs[LAST_PRS].mergedAt) : -Infinity;
    const last = conn.nodes?.at(-1);
    if (!conn.pageInfo?.hasNextPage || !last || Date.parse(last.updatedAt) < floor) break;
    after = conn.pageInfo.endCursor;
  }
  return prs;
}

// One page of merged PRs, newest update first.
async function mergedPage(gh, owner, name, after) {
  const cursor = after ? `, after: "${after}"` : '';
  const body = await graphql(gh, `query { repository(owner: "${owner}", name: "${name}") { pullRequests(states: MERGED, first: ${PR_PAGE}, orderBy: {field: UPDATED_AT, direction: DESC}${cursor}) { pageInfo { hasNextPage endCursor } nodes { ${PR_FIELDS} } } } }`);
  if (body.errors?.length) throw new Error(String(body.errors[0].message ?? body.errors[0].type));
  const conn = body.data?.repository?.pullRequests;
  if (!conn) throw new Error('no pullRequests in the response');
  return conn;
}

// What came after the merges: merged PRs titled Revert, and bug issues opened
// since the oldest of the last LAST_PRS merges, each kept only for the PR
// numbers it names.
export async function readLater(repo, gh, since) {
  const reverts = JSON.parse(await gh(['pr', 'list', '-R', repo, '--state', 'merged', '--search', 'Revert in:title', '--json', 'number,title,body,mergedAt', '--limit', '200']));
  const day = new Date(since).toISOString().slice(0, 10);
  const bugs = JSON.parse(await gh(['issue', 'list', '-R', repo, '--type', 'Bug', '--state', 'all', '--search', `created:>=${day}`, '--json', 'number,title,body,createdAt', '--limit', '1000']));
  return {
    reverts: reverts.map((r) => ({ at: Date.parse(r.mergedAt), title: String(r.title ?? ''), refs: prRefs(`${r.title}\n${r.body}`, repo) })),
    bugs: bugs.map((b) => ({ number: b.number, at: Date.parse(b.createdAt), causes: causes(`${b.title}\n${b.body}`, repo) })),
  };
}

// The revert circuit breaker: enforcement PRs among the last LAST_PRS merged
// that a later PR reverted, by title or by number, or that a bug issue opened
// after the merge names. Enforcement is params.enforcement_paths; ENFORCEMENT
// is the template's list.
export const ENFORCEMENT = (TEMPLATE.enforcement_paths ?? []).map((re) => new RegExp(re));
// The revert breaker: how many of the last PRs touching params.enforcement_paths a later merged PR reverted.
export function breaker(prs, github, { val, cnc, LASTN, enforcement }) {
  const source = `the ${LASTN} touching ${enforcement.map((re) => re.source).join(', ')} (gh api graphql files), against later merged PRs titled Revert that name them (gh pr list, title and body) and bug issues opened since the oldest of them merged that name them as the cause, with a Regressed-by line or a cause phrase such as "caused by #N" (gh issue list --type Bug)`
  if (github.error || !github.later) {
    cnc('blockers.enforcement_reverts', github.error ?? github.laterError ?? 'no merged PRs were read', source);
    return;
  }
  const enforced = prs.filter((pr) => (pr.files?.nodes ?? []).some((f) => enforcement.some((re) => re.test(f.path))));
  const hits = [];
  for (const pr of enforced) {
    const merged = Date.parse(pr.mergedAt);
    const reverted = github.later.reverts.some((r) => r.at > merged && (r.refs.has(pr.number) || (pr.title && r.title.includes(`"${pr.title}"`))));
    const bug = github.later.bugs.find((b) => b.at > merged && b.causes.has(pr.number));
    if (reverted) hits.push({ label: `#${pr.number} reverted`, value: 1, unit: 'PRs' });
    else if (bug) hits.push({ label: `#${pr.number} caused bug #${bug.number}`, value: 1, unit: 'PRs' });
  }
  val('blockers.enforcement_reverts', hits.length, source, [{ label: 'enforcement PRs merged', value: enforced.length, unit: 'PRs' }, ...hits]);
}

// Pinned review rounds before the merge, one per reviewed commit, oldest
// first: reviews by `reviewer`, or by anyone when it is empty. A round found
// something when the PR's final head is another commit; a round on the final
// head confirms a fix when an earlier round found one, and is clean when none
// did.
export function reviewRounds(pr, reviewer = '') {
  const merged = Date.parse(pr.mergedAt);
  const first = new Map();
  for (const r of pr.reviews?.nodes ?? []) {
    const oid = r.commit?.oid;
    const at = Date.parse(r.submittedAt);
    if ((reviewer && r.author?.login !== reviewer) || !oid || !(at <= merged)) continue;
    if (!(first.get(oid) <= at)) first.set(oid, at);
  }
  let found = false;
  return [...first]
    .sort((a, b) => a[1] - b[1])
    .map(([oid, at]) => {
      const kind = oid !== pr.headRefOid ? 'found' : found ? 'confirm' : 'clean';
      found ||= kind === 'found';
      return { oid, at, kind };
    });
}

// Each commit that started checks: when it was pushed (its first check
// suite), how long until its last check run finished, and the checks that failed on it, flaky when the same name later passed.
export function pushes(pr) {
  const out = [];
  for (const { commit } of pr.commits?.nodes ?? []) {
    const suites = (commit?.checkSuites?.nodes ?? []).filter((s) => s.checkRuns?.nodes?.length);
    const runs = suites.flatMap((s) => s.checkRuns.nodes);
    const pushedAt = Math.min(...suites.map((s) => Date.parse(s.createdAt)));
    const done = runs.map((r) => Date.parse(r.completedAt)).filter(Number.isFinite);
    if (!done.length || !Number.isFinite(pushedAt)) continue;
    const red = new Set();
    const flaky = new Set();
    for (const r of [...runs].sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt))) {
      if (RED.has(r.conclusion)) red.add(r.name);
      else if (r.conclusion === 'SUCCESS' && red.has(r.name)) flaky.add(r.name);
    }
    out.push({
      oid: commit.oid,
      pushedAt,
      waitMin: (Math.max(...done) - pushedAt) / MIN,
      red: red.size,
      flaky: flaky.size,
    });
  }
  return out;
}

// ------------------------------------------------------------------ verdict

// helps: false alarms are under half of its fires. costs: half or more. Not
// measured: no false-alarm share, because nothing measures its catches or
// its fires could not be read; its time and tokens still show in the row.
export function verdict(row) {
  if (!Number.isFinite(row.fires) || !Number.isFinite(row.false_alarm)) return 'not-measured';
  return row.false_alarm >= 50 ? 'costs' : 'helps';
}
