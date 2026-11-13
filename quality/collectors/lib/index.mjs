// The engine's helpers a collector may use, the one door between a collector
// and the engine: collect.mjs passes this module to each collect() as `lib`,
// so a pack's collector imports no engine file. Git Crafter's own collectors
// may import it by path; seam.test.mjs checks none reaches past it.
export { redact, redactText } from './redact.mjs';
export { managedClaudeMd, ownRepo, PROJECTS_DIR, projectMatch, remoteRepo, resolvePath } from './paths.mjs';
export { CHARTS, loadTargets, scoreMetric, TEXT_FIELDS } from './score.mjs';
export { GhError, ghClient, percentile, repoOf } from '../github/github-core.mjs';
export { firstLine, measured, runCommand, unknown } from '../run.mjs';
export { expandGlobs } from '../docs/docs-files.mjs';
export { PULL_FIELDS } from '../github/github-queries.mjs';
export { causes, prRefs } from '../github/github-refs.mjs';
export { greenAt, reverts } from '../github/github-reviews.mjs';
