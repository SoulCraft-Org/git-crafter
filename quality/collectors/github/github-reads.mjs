// The GitHub collector's larger reads: branch protection and the project board's cards.
import { GhError, connection } from "./github-core.mjs";
import { PROJECT_FIND, PROJECT_ITEMS, PROJECT_WORKFLOWS } from "./github-queries.mjs";

// Text escaped for use inside a regular expression.
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The default branch's classic protection and rulesets, folded into the facts the metrics read. */
export async function readProtection(L, gh, repo) {
  const branch = await L.branch();
  const classic = await classicProtection(gh, repo, branch);
  const rules = await gh.rest(`repos/${repo}/rules/branches/${branch}`);
  const types = new Set(rules.map((r) => r.type));
  return {
    classic: Boolean(classic),
    rulesets: rules.length,
    checks: requiredChecks(classic, rules),
    requirePr: Boolean(classic?.required_pull_request_reviews) || types.has("pull_request"),
    blockForcePush: (Boolean(classic) && !classic.allow_force_pushes?.enabled) || types.has("non_fast_forward"),
    blockDeletion: (Boolean(classic) && !classic.allow_deletions?.enabled) || types.has("deletion"),
  };
}

/** The branch's classic protection, or null when it has none. */
export async function classicProtection(gh, repo, branch) {
  try {
    return await gh.rest(`repos/${repo}/branches/${branch}/protection`);
  } catch (err) {
    if (err instanceof GhError && err.status === 404 && /not protected/i.test(err.message)) return null;
    throw err;
  }
}

// The required status check names from classic protection and rulesets, without repeats.
function requiredChecks(classic, rules) {
  return [
    ...new Set([
      ...(classic?.required_status_checks?.contexts ?? []),
      ...(classic?.required_status_checks?.checks ?? []).map((c) => c.context),
      ...rules.filter((r) => r.type === "required_status_checks").flatMap((r) => r.parameters.required_status_checks.map((c) => c.context)),
    ]),
  ];
}

/** The board's cards: status, linked pull requests (by link, closing reference or a URL in a draft's body) and draft text. */
export async function readProject(gh, repo, owner, name, cfg) {
  const found = await gh.graphql(PROJECT_FIND, { owner, title: cfg.projectTitle });
  const project = found.repositoryOwner?.projectsV2?.nodes.find((p) => p.title === cfg.projectTitle);
  if (!project) return null;
  const items = await connection(gh, PROJECT_ITEMS, { id: project.id }, (d) => d.node.items);
  // A draft card links its PR by URL in its body; resolve those numbers in one query.
  const urlPattern = new RegExp(`github\\.com/${escapeRegExp(repo)}/pull/(\\d+)`, "gi");
  const numbers = new Set(items.flatMap((it) => (it.content?.__typename === "DraftIssue" ? [...(it.content.body ?? "").matchAll(urlPattern)].map((m) => Number(m[1])) : [])));
  const drafts = await draftLinks(gh, owner, name, numbers);
  // The board's built-in workflows ride on the cards list. A refused read keeps its error for projects.workflows_on alone.
  const workflows = await gh.graphql(PROJECT_WORKFLOWS, { id: project.id }).then(
    (d) => (d.node ? (d.node.workflows?.nodes ?? []) : { error: new Error(`the board ${cfg.projectTitle} answered no workflows`) }),
    (error) => ({ error }),
  );
  return Object.assign(items.map((it) => cardOf(it, urlPattern, drafts)), { workflows });
}

/** The pull requests behind the draft cards' URLs, by number, in one query. */
async function draftLinks(gh, owner, name, numbers) {
  if (!numbers.size) return new Map();
  const aliases = [...numbers].map((n) => `p${n}: issueOrPullRequest(number: ${n}) { ... on PullRequest { number merged state createdAt } }`);
  const data = await gh.graphql(`query DraftLinks($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${aliases.join(" ")} } }`, { owner, name });
  return new Map(Object.values(data.repository).filter((p) => p?.number).map((p) => [p.number, p]));
}

// What a card is and shows: a draft, an issue (with its number, whether it is closed, its labels and type) or a pull request, and the body a draft or an issue carries.
const faceOf = (c, isDraft) => ({
  kind: isDraft ? "draft" : c?.__typename === "Issue" ? "issue" : "pull",
  number: c?.number ?? null,
  closed: c?.state === "CLOSED",
  body: c?.body ?? "",
  labels: (c?.labels?.nodes ?? []).map((l) => l.name),
  type: c?.issueType?.name ?? null,
});

// One project card: its status, when it was set, every PR that did its work, without repeats, and its face (faceOf).
export function cardOf(it, urlPattern, drafts) {
  const c = it.content;
  const pulls = [...(it.linked?.pullRequests?.nodes ?? [])];
  if (c?.__typename === "PullRequest") pulls.push(c);
  if (c?.__typename === "Issue") {
    // A PR that says "part of #N" or "refs #N" did the work without closing the issue: the issue's timeline lists it.
    const mentions = (c.timelineItems?.nodes ?? []).map((n) => n.source).filter((p) => p?.number);
    pulls.push(...c.closedByPullRequestsReferences.nodes, ...mentions);
  }
  const isDraft = c?.__typename === "DraftIssue";
  if (isDraft) pulls.push(...[...(c.body ?? "").matchAll(urlPattern)].map((m) => drafts.get(Number(m[1]))).filter(Boolean));
  const seen = new Set();
  pulls.splice(0, pulls.length, ...pulls.filter((p) => !seen.has(p.number) && seen.add(p.number)));
  return { createdAt: it.createdAt, status: it.status?.name ?? "No status", statusAt: it.status?.updatedAt, pulls, draftBody: isDraft ? (c.body ?? "") : null, ...faceOf(c, isDraft) };
}
