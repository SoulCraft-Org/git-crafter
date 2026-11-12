// How the GitHub collector reads PR references in text, and which PRs a body says caused a regression.

// A PR as text names it: #N, owner/repo#N, /pull/N, or a URL to it
// (https://github.com/owner/repo/pull/N). Not &#N (an HTML entity) and not a#N
// inside a word. REF captures the repository a reference names, if any, and N;
// BARE is the same pattern capturing nothing.
const REF = String.raw`(?:(?:https?:\/\/)?github\.com\/([\w.-]+\/[\w.-]+)\/pull\/|([\w.-]+\/[\w.-]+)#|(?<![\w&])#|(?<![\w.-])\/pull\/)(\d+)\b`;

const BARE = REF.replace(/\((?!\?)/g, '(?:');

// The PR numbers a text names in `repo` (owner/name, any case): a reference
// that names no repository is this one's, and one that names another
// repository is not this repository's PR of that number. With no repo, every
// reference counts.
function refsTo(text, repo) {
  const own = String(repo ?? '').toLowerCase();
  return [...String(text ?? '').matchAll(new RegExp(REF, 'gi'))]
    .filter((m) => {
      const named = (m[1] ?? m[2] ?? '').toLowerCase();
      return !named || !own || named === own;
    })
    .map((m) => Number(m[3]));
}

/** The PR numbers a text names, as a Set; `repo` is owner/name. */
export const prRefs = (text, repo) => new Set(refsTo(text, repo));

// A bug names a PR as its cause with a Regressed-by line, a list item too,
// naming one PR or several (Regressed-by: #5, #6), or with a cause phrase
// right before a PR; a cause phrase takes one PR, the first after it. Each
// separator between PRs is one unit, so a long run of spaces cannot backtrack. A PR mentioned for context does not count, and neither
// does a quoted line (> ...): a quote may be someone else's claim. The
// Blockers and Claude tabs both read regressions this way.
const REGRESSED = new RegExp(String.raw`^[ \t]*(?:[-*+][ \t]+)?Regressed-by:[ \t]*(${BARE}(?:(?:[ \t]*(?:,|and|&)[ \t]*|[ \t]+)${BARE})*)`, 'gim');

const PHRASE = new RegExp(String.raw`\b(?:caused by|introduced (?:in|by)|regress(?:ed|ion) (?:in|from|by)|broken by|broke in)[ \t]+(?:PR[ \t]+)?(${BARE})`, 'gi');

/** The PR numbers a text blames for a regression, by a Regressed-by line or a phrase such as "caused by". */
export function causes(text, repo) {
  const unquoted = String(text ?? '').split('\n').filter((line) => !/^[ \t]*>/.test(line)).join('\n');
  return new Set([...unquoted.matchAll(REGRESSED), ...unquoted.matchAll(PHRASE)].flatMap((m) => refsTo(m[1], repo)));
}
