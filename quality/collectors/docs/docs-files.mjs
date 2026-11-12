// Files, globs, overlays and area maps for the Documentation collector (docs.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { escapeRe, GIT_DIR, isFile, realpath, TARGETS } from './docs-util.mjs';

// A glob (*, ** and ?) as an anchored regular expression.
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += escapeRe(c);
  }
  return new RegExp(`^${re}$`);
}

// Files matching any glob, less those matching a glob that starts with "!".
// A deep glob never walks into a folder named in `skip`.
export function expandGlobs(root, globs, skip = GIT_DIR) {
  const found = new Set();
  const drop = globs.filter((g) => g.startsWith('!')).map((g) => globToRegExp(g.slice(1)));
  for (const glob of globs.filter((g) => !g.startsWith('!'))) {
    const parts = glob.split('/');
    const magic = parts.findIndex((s) => /[*?]/.test(s));
    if (magic < 0) {
      if (isFile(path.join(root, glob))) found.add(glob);
      continue;
    }
    const re = globToRegExp(glob);
    const deep = parts.length - magic > 1 || parts[magic] === '**';
    for (const rel of walk(root, parts.slice(0, magic).join('/'), deep, skip)) if (re.test(rel)) found.add(rel);
  }
  return [...found].filter((rel) => !drop.some((re) => re.test(rel))).sort();
}

function walk(root, base, deep, skip) {
  const out = [];
  const visit = (rel) => {
    let entries;
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isFile()) out.push(child);
      else if (e.isDirectory() && deep && !skip.has(e.name)) visit(child);
    }
  };
  visit(base);
  return out;
}

const norm = (p) => {
  const n = path.posix.normalize(p.replace(/\/+$/, '') || '.');
  return n === '.' ? '' : n;
};
const isFolder = (root, rel) => { try { return fs.statSync(path.join(root, rel)).isDirectory(); } catch { return false; } };

// The problem with one params.overlays entry's shape, or null.
const hasText = (o) => Boolean(o) && typeof o.dir === 'string' && typeof o.onto === 'string' && typeof o.why === 'string' && Boolean(o.why.trim());

function overlayShape(o, at) {
  if (!hasText(o)) return `${at} needs dir, onto and why, each text (${TARGETS})`;
  if (o.dir.startsWith('/') || o.onto.startsWith('/')) return `${at}: dir and onto are paths inside the repo, never absolute ones`;
  if (!norm(o.dir) || norm(o.dir).startsWith('..') || norm(o.onto).startsWith('..')) return `${at}: dir must be a folder inside the repo other than its root, and onto one too or "" for the root`;
  return null;
}

// The problem with one params.overlays entry, or null.
function overlayProblem(root, o, at, realRoot) {
  const shape = overlayShape(o, at);
  if (shape) return shape;
  const dir = norm(o.dir);
  const onto = norm(o.onto);
  let files = [];
  try { files = fs.readdirSync(path.join(root, dir)); } catch { /* not a folder */ }
  if (!files.length) return `${at}: ${o.dir} matches no file`;
  if (onto && !isFolder(root, onto)) return `${at}: onto ${o.onto} is no folder in the repo`;
  const under = (rel) => {
    const real = realpath(path.join(root, rel));
    return real === realRoot || real.startsWith(realRoot + path.sep);
  };
  const outside = [['dir', dir], ['onto', onto]].find(([, rel]) => rel && !under(rel));
  return outside ? `${at}: ${outside[0]} ${o[outside[0]]} resolves outside the repo` : null;
}

// params.overlays, checked: each { dir, onto, why } names a folder inside the
// repo that holds files (never the root itself), the existing folder an
// export places it at ("" for the root), and why. Both are repo paths, never
// absolute, and neither may resolve outside the repo through a symlink.
// Returns { overlays }, normalized, or { problem } for the first malformed
// entry: never a silent pass.
export function readOverlays(root, list) {
  if (list === undefined) return { overlays: [] };
  if (!Array.isArray(list)) return { problem: `params.overlays must be a list of { dir, onto, why } (${TARGETS})` };
  const realRoot = realpath(root);
  const overlays = [];
  for (const [i, o] of list.entries()) {
    const problem = overlayProblem(root, o, `params.overlays[${i}]`, realRoot);
    if (problem) return { problem };
    overlays.push({ dir: norm(o.dir), onto: norm(o.onto) });
  }
  return { overlays };
}

// The overlay a doc sits under, the deepest dir first, or undefined.
export function overlayOf(overlays, doc) {
  return overlays.filter((o) => doc.startsWith(`${o.dir}/`)).sort((a, b) => b.dir.length - a.dir.length)[0];
}

// The repo path a doc's relative or root-absolute path resolves to, or null
// when it leaves the tree or matches no file. A doc under an overlay sits at
// onto plus its path inside dir; "/" is onto, a path that climbs out of onto
// stays unresolved, and the overlay's copy wins over the repository's.
export function locatePath(root, overlays, doc, target) {
  const exists = (rel) => fs.existsSync(path.join(root, rel));
  const o = overlayOf(overlays, doc);
  if (!o) {
    const rel = path.posix.normalize(target.startsWith('/') ? target.slice(1) : path.posix.join(path.posix.dirname(doc), target));
    return rel.startsWith('..') || !exists(rel) ? null : rel;
  }
  const at = path.posix.join(o.onto, doc.slice(o.dir.length + 1));
  const to = path.posix.normalize(target.startsWith('/') ? path.posix.join(o.onto, target.slice(1)) : path.posix.join(path.posix.dirname(at), target));
  const within = withinOnto(to, o.onto || '.');
  if (within === null) return null;
  return [path.posix.join(o.dir, within), path.posix.join(o.onto, within)].find(exists) ?? null;
}

// The part of `to` under `base`, '' for base itself, or null when it is outside.
function withinOnto(to, base) {
  if (to === base) return '';
  if (base === '.') return to.startsWith('..') ? null : to;
  return to.startsWith(`${base}/`) ? to.slice(base.length + 1) : null;
}

// The first params.areas entry whose doc glob matches, or null.
export function areaEntry(doc, areas) {
  if (!Array.isArray(areas)) return null;
  return areas.find((a) => a && typeof a.doc === 'string' && globToRegExp(a.doc).test(doc)) ?? null;
}

// A doc's area paths, from its params.areas entry; {dir} is the doc's folder,
// and [] is a record, mapped to nothing on purpose. null when no entry
// matches or the entry's area is not a list of paths: docs.unmapped names it.
export function areaFor(doc, areas) {
  const hit = areaEntry(doc, areas);
  if (!hit || !Array.isArray(hit.area) || !hit.area.every((s) => typeof s === 'string')) return null;
  const dir = path.posix.dirname(doc);
  return hit.area.map((s) => s.replace('{dir}', dir));
}
