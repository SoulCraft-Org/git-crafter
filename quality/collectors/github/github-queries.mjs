// The GraphQL queries the GitHub collector sends, the page sizes they use and the field lists its tests share.

// Read a few more than 20, most recently updated first: a merge updates a PR,
// so one opened long ago but merged today is among them. Then sorted by
// mergedAt for the 20 latest merges; still one call.
export const MERGED_PAGE = 30;

const LAST_BRANCH_COMMITS = 20;

// The newest issues, whose bodies the card metrics read.
export const LAST_CARDS = 20;

export const ISSUES = `query Issues($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    issues(first: 100, after: $cursor, orderBy: {field: CREATED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number state stateReason createdAt closedAt issueType { name }
        labels(first: 20) { nodes { name } }
        closedBy: timelineItems(itemTypes: [CLOSED_EVENT], last: 1) {
          nodes { ... on ClosedEvent { closer { __typename
            ... on PullRequest { merged }
            ... on Commit { associatedPullRequests(first: 5) { nodes { merged } } } } } }
        }
        reopened: timelineItems(itemTypes: [REOPENED_EVENT]) { totalCount }
      }
    }
  }
}`;

/**
 * The pull request fields that reviewedLines, fixedAfterReview and reverts
 * read. The Claude tab fetches its PRs with this same selection, so both tabs
 * judge a PR from the same data.
 */
export const PULL_FIELDS = `number title createdAt mergedAt additions deletions headRefOid
        files(first: 100) { nodes { path additions deletions changeType } }
        reviews(last: 50, states: [COMMENTED, APPROVED, CHANGES_REQUESTED, DISMISSED]) {
          nodes { submittedAt commit { oid } author { __typename } }
        }`;

/**
 * The review verdicts posted as comments, and the PR's commits they may name.
 * Merged PRs read them for reviewMarkers; aliased, so a query that also reads
 * commits for its own use, as the Claude tab's does, stays valid.
 */
export const MARKER_FIELDS = `markerComments: comments(last: 50) { nodes { body createdAt lastEditedAt authorAssociation } }
        markerCommits: commits(last: 100) { nodes { commit { oid } } }`;

// The head commit's checks: the rollup state, and each run's name, result and finish time, which isGreen and greenAt read.
const HEAD_ROLLUP = `headCommit: commits(last: 1) { nodes { commit { statusCheckRollup { state
          contexts(first: 100) { nodes { __typename ... on CheckRun { name conclusion completedAt checkSuite { workflowRun { workflow { name } } } } ... on StatusContext { context state createdAt } } }
        } } } }`;

export const MERGED_PULLS = `query MergedPulls($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: MERGED, first: ${MERGED_PAGE}, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        ${PULL_FIELDS}
        ${MARKER_FIELDS}
        body baseRefName baseRepository { defaultBranchRef { name } } stack { number } mergeCommit { oid }
        ${HEAD_ROLLUP}
      }
    }
  }
}`;

export const OPEN_PULLS = `query OpenPulls($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number createdAt mergeable baseRefName author { login } labels(first: 10) { nodes { name } }
        isDraft headRefOid reviewDecision reviewRequests(first: 1) { totalCount }
        reviews(last: 50, states: [COMMENTED, APPROVED, CHANGES_REQUESTED, DISMISSED]) { nodes { submittedAt commit { oid } author { __typename } } }
        markerComments: comments(last: 50) { nodes { body createdAt lastEditedAt authorAssociation } }
        ${HEAD_ROLLUP}
      }
    }
  }
}`;

export const RECENT_ISSUES = `query RecentIssues($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    issues(first: ${LAST_CARDS}, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { number createdAt body } }
  }
}`;

// The Issues tab's own reads, each apart from ISSUES so the metrics that only
// need ISSUES never wait on a field a host may lack.
export const OPEN_ISSUE_TYPES = `query OpenIssueTypes($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    issues(states: OPEN, first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { number createdAt issueType { name } labels(first: 20) { nodes { name } } }
    }
  }
}`;

export const LABEL_USE = `query LabelUse($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    labels(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { name issues { totalCount } pullRequests { totalCount } }
    }
  }
}`;

export const BRANCH_COMMITS = `query BranchCommits($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { target { ... on Commit {
      history(first: ${LAST_BRANCH_COMMITS}) { nodes { oid associatedPullRequests(first: 5) { nodes { merged } } } }
    } } }
  }
}`;

// An organization or a user can own a project board.
export const SECURITY_POLICY = `query SecurityPolicy($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { isSecurityPolicyEnabled }
}`;

export const VULNERABILITY_ALERTS = `query VulnerabilityAlerts($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { hasVulnerabilityAlertsEnabled }
}`;

export const PROJECT_FIND = `query ProjectFind($owner: String!, $title: String!) {
  repositoryOwner(login: $owner) { ... on ProjectV2Owner { projectsV2(first: 20, query: $title) { nodes { id title } } } }
}`;

// The board's built-in workflows, read apart from its cards: GitHub refuses them to an App's token, which reads the cards.
export const PROJECT_WORKFLOWS = `query ProjectWorkflows($id: ID!) {
  node(id: $id) { ... on ProjectV2 { workflows(first: 20) { nodes { name enabled } } } }
}`;

export const PROJECT_ITEMS = `query ProjectItems($id: ID!, $cursor: String) {
  node(id: $id) { ... on ProjectV2 {
    items(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        createdAt
        status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name updatedAt } }
        linked: fieldValueByName(name: "Linked pull requests") {
          ... on ProjectV2ItemFieldPullRequestValue { pullRequests(first: 5) { nodes { number merged state createdAt } } }
        }
        content { __typename
          ... on PullRequest { number merged state createdAt }
          ... on Issue { number state body labels(first: 20) { nodes { name } } issueType { name }
            closedByPullRequestsReferences(first: 5, includeClosedPrs: true) { nodes { number merged state createdAt } }
            timelineItems(first: 20, itemTypes: [CROSS_REFERENCED_EVENT]) { nodes { ... on CrossReferencedEvent { source { ... on PullRequest { number merged state createdAt } } } } } }
          ... on DraftIssue { body } }
      }
    }
  } }
}`;
