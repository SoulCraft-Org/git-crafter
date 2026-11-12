// Small helpers for the Documentation collector (docs.mjs).
import fs from 'node:fs';
import path from 'node:path';

// Where a repo sets the params the collector names in its messages.
export const TARGETS = 'quality/targets/docs.json';
export const GIT_DIR = new Set(['.git']); // never walked; params.skip_dirs adds the rest

// A doc's top-level folder, or the repo root.
function folderOf(doc) {
  return doc.includes('/') ? `${doc.split('/')[0]}/` : 'repo root';
}

// Docs counted by top-level folder, as { label, value } rows.
export function byFolder(docs) {
  const n = new Map();
  for (const doc of docs) n.set(folderOf(doc), (n.get(folderOf(doc)) || 0) + 1);
  return [...n].map(([label, value]) => ({ label, value }));
}

// True when the path is a file.
export function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
// True when the folder holds a README file.
export function hasReadme(dir) {
  try { return fs.readdirSync(dir).some((n) => /^readme(\.(md|markdown|txt|rst))?$/i.test(n) && isFile(path.join(dir, n))); } catch { return false; }
}
// The path with links resolved, or as given when it cannot be.
export function realpath(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}
// A path without its trailing slash.
export function bare(s) { return s.replace(/\/$/, ''); }
// The sum of a list of numbers.
export function sum(xs) { return xs.reduce((a, b) => a + b, 0); }
// Rounds to one decimal.
export function round1(x) { return Math.round(x * 10) / 10; }
// Whole days from date a to date b.
export function daysBetween(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 86400000); }
// Text escaped for use inside a regular expression.
export function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
// Text split at the first sep, as [before, after].
export function splitOnce(s, sep) { const i = s.indexOf(sep); return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)]; }
// The first line of trimmed text.
export function firstLine(s) { return String(s || '').trim().split('\n')[0]; }
