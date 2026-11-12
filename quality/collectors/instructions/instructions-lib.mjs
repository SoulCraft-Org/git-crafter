// File and listing helpers for the instructions collector (instructions.mjs).

import fs from 'node:fs';
import path from 'node:path';

export const HEAD = 64 * 1024;
// A value as a list: a list as is, one value wrapped, nothing as empty.
export const toList = (v) => (Array.isArray(v) ? v : v ? [v] : []);
// True for a .md file name.
export const md = (f) => f.endsWith('.md');

// The result of read(), or { error } naming why it could not read.
export function attempt(read) {
  try {
    return read();
  } catch (err) {
    return { error: `could not read (${err.code ?? String(err.message).split('\n')[0].slice(0, 160)})` };
  }
}

// The sum of a list of numbers.
export const sum = (xs) => xs.reduce((a, b) => a + b, 0);
// A detail row.
export const item = (label, value, unit) => ({ label, value, unit });
// An epoch time as "YYYY-MM-DD HH:MM".
export const iso = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

// Absent is not loaded; any other error (a path through a file, no access) throws.
export function exists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

// A folder's entries that pass keep, sorted, as full paths; empty when it is missing.
export function listDir(dir, keep) {
  if (!dir || !exists(dir)) return [];
  return fs.readdirSync(dir).filter(keep).sort().map((f) => path.join(dir, f));
}

// The lines in a buffer, a last line without a break included.
export const lineCount = (buf) => {
  let n = 0;
  for (const b of buf) if (b === 10) n += 1;
  return buf.length && buf[buf.length - 1] !== 10 ? n + 1 : n;
};

// The bytes and lines of MEMORY.md that load: up to its Nth line break or
// the byte cap, whichever comes first. Only line breaks are looked at.
export function memoryHead(file, maxLines, maxBytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(Math.min(fs.fstatSync(fd).size, maxBytes));
    const n = fs.readSync(fd, head, 0, head.length, 0);
    let lines = 0;
    for (let i = 0; i < n; i++) if (head[i] === 10 && ++lines === maxLines) return { bytes: i + 1, lines };
    return { bytes: n, lines: lineCount(head.subarray(0, n)) };
  } finally {
    fs.closeSync(fd);
  }
}

// ------------------------------------------------------------ frontmatter

// The frontmatter as key to text: a key's value and its indented or list
// continuation lines, block scalar marks and quotes dropped.
export function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  if (!m) return out;
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const k = /^([\w-]+)\s*:\s*(.*)$/.exec(line);
    if (k) {
      key = k[1];
      out[key] = [/^[>|][+-]?$/.test(k[2].trim()) ? '' : k[2].trim()];
    } else if (key && line.trim()) out[key].push(line.trim());
  }
  return Object.fromEntries(Object.entries(out).map(([k, parts]) => [k, parts.filter(Boolean).map(unquote)]));
}
// A frontmatter value without its list dash and quotes.
const unquote = (s) => s.replace(/^- /, '').replace(/^(["'])(.*)\1$/, '$2');
// A frontmatter key's lines joined by spaces.
const joined = (fm, key) => (fm[key] ?? []).join(' ');

// True for a rule file with no paths, which loads every session.
export const loadsAlways = (file) => rulePaths(file).length === 0;

// A rule's paths globs: a list, an inline [a, b] or one value.
export function rulePaths(file) {
  const fm = frontmatter(fs.readFileSync(file, 'utf8').slice(0, HEAD));
  // An inline list splits on commas outside quotes and braces.
  const split = (v) => (/^\[.*\]$/.test(v) ? [...v.slice(1, -1).matchAll(/"[^"]*"|'[^']*'|(?:[^,{"']|\{[^}]*\})+/g)].map((m) => m[0]) : [v]);
  return (fm.paths ?? []).flatMap(split).map((v) => unquote(v.trim())).filter(Boolean);
}

// What one listing entry costs: its name, description and when_to_use.
function listing(file, fallbackName) {
  const fm = frontmatter(fs.readFileSync(file, 'utf8').slice(0, HEAD));
  const name = joined(fm, 'name') || fallbackName;
  return { name, file, listBytes: Buffer.byteLength(name) + Buffer.byteLength(joined(fm, 'description')) + Buffer.byteLength(joined(fm, 'when_to_use')) };
}

// Each skill folder under dir holding skillFile, as a listing.
export function skillsIn(dir, skillFile) {
  if (!exists(dir)) return [];
  return fs
    .readdirSync(dir)
    .sort()
    .filter((d) => !d.startsWith('.') && exists(path.join(dir, d, skillFile)))
    .map((d) => listing(path.join(dir, d, skillFile), d));
}

// Each agent .md file under dir, as a listing.
export function agentsIn(dir) {
  return listDir(dir, md).map((p) => listing(p, path.basename(p).replace(/\.\w+$/, '')));
}
