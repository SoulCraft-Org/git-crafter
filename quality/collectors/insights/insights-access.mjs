// The Insights tab's branch and access metrics: leftover branches, how long the oldest has waited, and people whose write access goes unused.
import { mapLimit } from "../ci/ci-core.mjs";
import { connection, count, DAY, HOUR, measured, round1, skip } from "../github/github-core.mjs";

/** People the People metric reads: the first page of collaborators. */
const PEOPLE = 100;

/** Branches the Network metric reads at most. */
const BRANCH_LIMIT = 1000;

const BRANCHES = `query Branches($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    refs(refPrefix: "refs/heads/", first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name
        target { ... on Commit { committedDate } }
        open: associatedPullRequests(states: OPEN) { totalCount }
        done: associatedPullRequests(states: [CLOSED, MERGED], first: 5, orderBy: { field: UPDATED_AT, direction: DESC }) { totalCount nodes { closedAt } }
      }
    }
  }
}`;

const EMPTY = { nodes: [], pageInfo: { hasNextPage: false } };

// Hours since the newest of the given ISO times, or null when none parses.
function hoursSince(times, now) {
  const at = times.map((t) => Date.parse(t)).filter(Number.isFinite);
  return at.length ? Math.max(0, (now - Math.max(...at)) / HOUR) : null;
}

/**
 * The leftover branches, each with the hours it has waited. A branch is
 * leftover once its pull request closed or merged, timed from that close, or
 * once it is `graceHours` old with no pull request, timed from its last
 * commit: live work pushed before its pull request does not count. The default
 * branch, a branch with an open pull request and the ones the repo keeps never do.
 */
export function leftoverOf(refs, defaultBranch, keep, now, graceHours) {
  const stays = (r) => r.name === defaultBranch || keep.includes(r.name) || Boolean(r.open?.totalCount);
  const out = [];
  for (const r of refs.filter((ref) => !stays(ref))) {
    const proposed = Boolean(r.done?.totalCount);
    const hours = hoursSince(proposed ? (r.done.nodes ?? []).map((p) => p.closedAt) : [r.target?.committedDate], now);
    if (proposed || (hours !== null && hours > graceHours)) out.push({ proposed, hours: hours ?? 0 });
  }
  return out;
}

/** How many branches are leftover, split by whether a pull request ever used them. */
export function leftoverBranches(left) {
  const done = left.filter((b) => b.proposed).length;
  return measured(left.length, [count("pull request merged or closed", done), count("no pull request for over a day", left.length - done)]);
}

/** Hours the oldest leftover branch has waited; 0 when there is none. */
export function oldestLeftoverHours(left) {
  return measured(round1(Math.max(0, ...left.map((b) => b.hours))), [count("leftover branches", left.length)]);
}

/** People whose latest default-branch commit is missing or older than `days`; `latest` holds one date or null per person. */
export function idleAccess(latest, now, days) {
  if (!latest.length) return skip("nobody with write access was listed");
  const idle = latest.filter((date) => !date || now - Date.parse(date) > days * DAY).length;
  return measured(idle, [count("people with write access", latest.length)]);
}

// The repo's leftover branches, read once per collect for both branch metrics; null when it has no default branch.
function readLeftover(ctx) {
  ctx.leftover ??= (async () => {
    const [owner, name] = ctx.repo.split("/");
    let base = null;
    const pick = (data) => {
      base = data?.repository?.defaultBranchRef?.name ?? null;
      return data?.repository?.refs ?? EMPTY;
    };
    const refs = await connection(ctx.gh, BRANCHES, { owner, name }, pick, BRANCH_LIMIT);
    const keep = Array.isArray(ctx.params.keep_branches) ? ctx.params.keep_branches : [];
    const grace = Number(ctx.params.branch_grace_hours) >= 0 ? Number(ctx.params.branch_grace_hours) : 24;
    return base ? leftoverOf(refs, base, keep, ctx.now, grace) : null;
  })();
  return ctx.leftover;
}

const NO_BASE = "the repo has no default branch";
const BRANCH_SOURCE = `state: GraphQL refs under refs/heads (the first ${BRANCH_LIMIT}) with their pull requests: a branch whose pull request closed or merged, or one older than params.branch_grace_hours with none; the default branch, open pull requests and params.keep_branches do not count`;

// The date of each person's latest default-branch commit, or null: people who can push, bots left out.
async function latestCommits({ gh, repo }) {
  const people = (await gh.restAll(`repos/${repo}/collaborators?per_page=${PEOPLE}`)).filter((p) => p.type !== "Bot" && p.permissions?.push);
  const latest = async (p) => (await gh.rest(`repos/${repo}/commits?author=${encodeURIComponent(p.login)}&per_page=1`))?.[0]?.commit?.committer?.date ?? null;
  return mapLimit(people.slice(0, PEOPLE), 8, latest);
}

/** The three metrics, in the shape insights.mjs's METRICS table holds. */
export const ACCESS_METRICS = {
  "insights.leftover_branches": {
    source: BRANCH_SOURCE,
    async run(ctx) {
      const left = await readLeftover(ctx);
      return left ? leftoverBranches(left) : skip(NO_BASE);
    },
  },
  "insights.oldest_leftover_hours": {
    source: `${BRANCH_SOURCE}; each timed from its pull request's close, or from its last commit`,
    async run(ctx) {
      const left = await readLeftover(ctx);
      return left ? oldestLeftoverHours(left) : skip(NO_BASE);
    },
  },
  "insights.idle_access": {
    source: `state: gh api repos/{repo}/collaborators (people who can push, the first ${PEOPLE}) and each one's latest default-branch commit (gh api repos/{repo}/commits?author=): those with none in params.idle_days days`,
    async run(ctx) {
      const days = Number(ctx.params.idle_days) > 0 ? Number(ctx.params.idle_days) : 90;
      return idleAccess(await latestCommits(ctx), ctx.now, days);
    },
  },
};
