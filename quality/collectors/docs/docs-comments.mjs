// What a file says apart from its comments, for telling a commit that changes only comments from one that changes code (docs-git.mjs).
import path from 'node:path';

const HASH = /^(py|sh|bash|zsh|ya?ml|toml|rb|pl|r|cfg|ini|conf)$/;
const SLASH = /^(js|mjs|cjs|jsx|ts|tsx|c|h|cc|cpp|hpp|java|go|rs|swift|kt|cs|php|scss)$/;
const BLOCK = /^(css)$/;
const MARKUP = /^(html?|md|markdown|xml|svg)$/;
const DASH = /^(sql|lua)$/;

// A line comment starts a line or follows a space, so the // of a URL in a string is never one; a #! line is code.
const lineComment = (re) => (text) => text.split('\n').map((l) => (l.startsWith('#!') ? l : l.replace(re, '$1'))).join('\n');
const STRIPS = {
  hash: lineComment(/(^|\s)#.*$/),
  slash: (text) => lineComment(/(^|\s)\/\/.*$/)(text.replace(/\/\*[\s\S]*?\*\//g, ' ')),
  block: (text) => text.replace(/\/\*[\s\S]*?\*\//g, ' '),
  markup: (text) => text.replace(/<!--[\s\S]*?-->/g, ' '),
  dash: lineComment(/(^|\s)--.*$/),
};

function styleOf(file) {
  const base = path.basename(file);
  if (/^(Dockerfile|Makefile)$/.test(base)) return 'hash';
  const ext = path.extname(base).slice(1).toLowerCase();
  if (HASH.test(ext)) return 'hash';
  if (SLASH.test(ext)) return 'slash';
  if (BLOCK.test(ext)) return 'block';
  if (MARKUP.test(ext)) return 'markup';
  if (DASH.test(ext)) return 'dash';
  return null;
}

/**
 * A file's text with its comments, blank lines and each line's outer spaces
 * taken out, so two versions that differ only in comments read the same; null
 * for a file whose comment syntax is not known, which never reads as comments.
 * Naive on purpose: a comment marker inside a string reads as a comment only
 * after a space, and a change there hides only if it sits after that marker.
 */
export function withoutComments(file, text) {
  const style = styleOf(file);
  if (!style) return null;
  return STRIPS[style](text).split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
}
