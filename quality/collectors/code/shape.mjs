// Repo-wide facts for the Code tab: copied code across files and file names
// against their folder's convention.
// code.mjs reads the disk and git; everything here takes lists and strings, so
// the tests feed it those.

// jscpd's defaults: a run of 5 code lines holding 50 or more tokens that
// appears again, in any code file, is a copy.
export const DUPLICATE = { minLines: 5, minTokens: 50 };

// files: [{ path, code: [{ line, text }] }] in a stable order. The first
// occurrence of a window is the original; every later copy counts. Returns the
// copied line count and the copied blocks, largest first, each naming the
// original it repeats.
export function duplicates(files) {
  const seen = new Map();
  const blocks = [];
  let copied = 0;
  for (const f of files) {
    const { marked, origin } = markCopies(f, seen);
    copied += marked.size;
    addBlocks(blocks, f, marked, origin);
  }
  return { copied, blocks: blocks.sort((a, b) => b.lines - a.lines) };
}

// The code-line indexes of one file that repeat a window seen before, and the
// original each copied window starts from. Records new windows in `seen`.
function markCopies(f, seen) {
  const { minLines, minTokens } = DUPLICATE;
  const marked = new Set();
  const origin = new Map();
  for (let i = 0; i + minLines <= f.code.length; i++) {
    const window = f.code.slice(i, i + minLines).map((c) => c.text);
    if (tokens(window.join(" ")) < minTokens) continue;
    const key = window.join("\n");
    const first = seen.get(key);
    if (!first) seen.set(key, { path: f.path, i, line: f.code[i].line });
    // A window that overlaps its own original is one repeated line, not a copy.
    else if (first.path !== f.path || i - first.i >= minLines) {
      origin.set(i, first);
      for (let j = i; j < i + minLines; j++) marked.add(j);
    }
  }
  return { marked, origin };
}

// A block starts where a copied window starts, so its origin is known.
function addBlocks(blocks, f, marked, origin) {
  const sorted = [...marked].sort((a, b) => a - b);
  for (let k = 0; k < sorted.length; k++) {
    if (k > 0 && sorted[k] === sorted[k - 1] + 1) blocks.at(-1).lines++;
    else blocks.push({ path: f.path, line: f.code[sorted[k]].line, lines: 1, of: origin.get(sorted[k]) });
  }
}

function tokens(text) {
  return text.match(/[\w$]+|[^\s\w$]/g)?.length ?? 0;
}

// The name cases a naming rule can allow. The name is the part before the
// first dot, so content.config.ts is "content".
export const CASES = {
  kebab: /^[a-z0-9]+(-[a-z0-9]+)*$/,
  snake: /^[a-z0-9]+(_[a-z0-9]+)*$/,
  pascal: /^[A-Z][A-Za-z0-9]*$/,
  camel: /^[a-z][A-Za-z0-9]*$/,
  route: /^\[(\.\.\.)?[a-z][\w-]*\]$/,
};

// rules: params.naming, [{ rule, path, cases }] in order. The first rule whose
// `path` pattern matches the file's path names its convention; null when none
// does, so a file no rule covers is not judged. A folder is a path ending in
// a slash, judged by its own name under the same rules.
export function namingRule(path, rules) {
  const base = path.endsWith("/") ? path.split("/").at(-2) : path.split("/").at(-1).split(".")[0];
  const hit = rules.find((r) => new RegExp(r.path).test(path));
  if (!hit) return null;
  return { rule: hit.rule, ok: hit.cases.some((c) => CASES[c]?.test(base)) };
}
