// The CI readers a repo's own collector, under config/quality/collectors/, loads on demand,
// kept out of index.mjs so a collector that needs neither never loads them.
export { ciClient } from '../ci/ci.mjs';
export { newestJob } from '../code/code-test.mjs';
