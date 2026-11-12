// The Tools collector's readers and judges: versions, direct dependencies,
// Action pins, Node setup and CI minutes (tools.mjs turns them into metrics).

import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

export const DAY = 864e5;
// Rounds to d decimals (one by default).
export const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

// ---- Versions ----------------------------------------------------------------

// "1.2.3" -> [1, 2, 3]; a prerelease ("1.2.3-rc.1") or a non-version is null.
export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? '').trim());
  return m ? m.slice(1).map(Number) : null;
}
// Compares two semantic versions: below 0, 0 or above 0.
export function compareVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

// The newest stable version at least ageDays old, from npm's time map.
export function eligibleVersion(times, now, ageDays) {
  const cutoff = now.getTime() - ageDays * DAY;
  return Object.entries(times)
    .filter(([v, t]) => parseVersion(v) && Date.parse(t) <= cutoff)
    .map(([v]) => v)
    .sort(compareVersions)
    .at(-1) ?? null;
}

// This repo's version tags (vX.Y.Z) with their commits, lowest version first,
// from gh api repos/{repo}/tags. Every page is read, 100 tags each, because
// the API promises no order: the newest tag may sit on any page.
export async function versionTags(repo, exec, cwd) {
  const tags = [];
  for (let page = 1; page <= TAG_PAGES; page++) {
    const got = JSON.parse(await exec('gh', ['api', `repos/${repo}/tags?per_page=100&page=${page}`], { cwd }));
    tags.push(...got);
    if (got.length < 100) break;
  }
  return tags.filter((t) => parseVersion(t.name)).map((t) => ({ name: t.name, sha: t.commit.sha })).sort((a, b) => compareVersions(a.name, b.name));
}
const TAG_PAGES = 20;

// The newest tag at least ageDays old, by its commit's committer date, with
// that age in whole days; null when no tag is that old. It walks down from
// the highest version and stops at the first old tag, so it reads one commit
// per tag younger than ageDays. A search by halves would read fewer, but a
// backport cut after a higher version would send it to too low a tag.
export async function cooledTag(tags, { repo, exec, cwd, now, ageDays }) {
  const cutoff = now.getTime() - ageDays * DAY;
  for (const tag of tags.toReversed()) {
    const date = Date.parse(JSON.parse(await exec('gh', ['api', `repos/${repo}/git/commits/${tag.sha}`], { cwd })).committer?.date);
    if (!Number.isFinite(date)) throw new Error(`${tag.name} has no commit date`);
    if (date <= cutoff) return { ...tag, age_days: Math.floor((now.getTime() - date) / DAY) };
  }
  return null;
}

// The version tag a pin names, by the tag's name or its commit (the highest
// when several tags share the commit); null for a branch or an untagged SHA.
export function pinTag(ref, tags) {
  return tags.findLast((t) => t.name === ref || t.sha === ref)?.name ?? null;
}

// Each `uses: <repo>/...@ref` in another repo's workflows, read with
// gh api contents: [{ file, ref, comment }].
export async function adopterPins(adopter, repo, exec, cwd) {
  const files = JSON.parse(await exec('gh', ['api', `repos/${adopter}/contents/.github/workflows`], { cwd })).filter((f) => /\.ya?ml$/.test(f.name));
  const esc = repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\s*-?\\s*uses:\\s*["']?${esc}/[^@\\s]*@([^\\s"'#]+)["']?\\s*(?:#\\s*(\\S+))?`, 'gim');
  const pins = [];
  for (const f of files) {
    const body = JSON.parse(await exec('gh', ['api', `repos/${adopter}/contents/${f.path}`], { cwd }));
    const text = Buffer.from(body.content ?? '', 'base64').toString('utf8');
    for (const m of text.matchAll(re)) pins.push({ file: f.name, ref: m[1], comment: m[2] ?? null });
  }
  return pins;
}

// npm dependencies whose next major the repo holds on purpose: a Dependabot
// npm ignore entry with update-types version-update:semver-major. Such a
// dependency is judged within its installed major, and shown as held.
export function heldMajors(root) {
  const file = ['.github/dependabot.yml', '.github/dependabot.yaml'].map((f) => path.join(root, f)).find((f) => fs.existsSync(f));
  if (!file) return new Set();
  const doc = parseYaml(fs.readFileSync(file, 'utf8')) ?? {};
  const held = new Set();
  for (const u of doc.updates ?? []) {
    if (u?.['package-ecosystem'] === 'npm') for (const name of heldNames(u)) held.add(name);
  }
  return held;
}

// The dependency names one npm update entry ignores for major updates.
function heldNames(u) {
  return (u.ignore ?? []).filter((i) => i?.['dependency-name'] && (i['update-types'] ?? []).includes('version-update:semver-major')).map((i) => i['dependency-name']);
}

// The versions in `times` on `installed`'s major line, for a held major.
export function sameMajor(times, installed) {
  const major = parseVersion(installed)?.[0];
  return Object.fromEntries(Object.entries(times).filter(([v]) => parseVersion(v) ? parseVersion(v)[0] === major : !/^\d/.test(v)));
}

// One direct dependency's state against the rule.
export function judge(name, installed, times, now, ageDays) {
  const eligible = eligibleVersion(times, now, ageDays);
  const stable = Object.keys(times).filter((v) => parseVersion(v)).sort(compareVersions);
  const newest = stable.at(-1) ?? null;
  const row = { label: name, installed, eligible, newest, released: installed && times[installed] ? times[installed].slice(0, 10) : null, majors_behind: 0, waiting_days: null };
  if (!parseVersion(installed) || !eligible) return { ...row, status: 'not read', value: null };
  const cmp = compareVersions(installed, eligible);
  row.majors_behind = Math.max(parseVersion(eligible)[0] - parseVersion(installed)[0], 0);
  if (cmp === 0) return { ...row, status: 'current', value: 0 };
  if (cmp > 0) return { ...row, status: 'too new', value: 0 };
  // The first version past the installed one that is now eligible: how long
  // it has waited since it became eligible.
  const firstNewer = stable.find((v) => compareVersions(v, installed) > 0 && compareVersions(v, eligible) <= 0);
  const waited = (now.getTime() - Date.parse(times[firstNewer]) - ageDays * DAY) / DAY;
  return { ...row, status: 'behind', waiting_days: Math.max(Math.floor(waited), 0), value: Math.max(Math.floor(waited), 0) };
}

// The lockfiles that pin what is installed, by package manager, first found
// wins: npm, npm's shrinkwrap, pnpm, Yarn.
export const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock'];

// The installed version of a direct dependency, by name, the folder that
// declares it and its range, from whichever lockfile the repo has.
export function lockfileVersions(root) {
  const file = LOCKFILES.find((f) => fs.existsSync(path.join(root, f)));
  if (!file) throw new Error(`no lockfile (${LOCKFILES.join(', ')})`);
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  if (file.endsWith('.json')) {
    const lock = JSON.parse(text);
    const at = (key) => lock.packages?.[key]?.version ?? null;
    return { file, version: (name, dir) => (dir !== '.' && at(`${dir}/node_modules/${name}`)) || at(`node_modules/${name}`) };
  }
  if (file === 'pnpm-lock.yaml') {
    const lock = parseYaml(text) ?? {};
    return {
      file,
      version: (name, dir) => {
        const imp = lock.importers?.[dir] ?? (dir === '.' ? lock : {});
        const e = imp.dependencies?.[name] ?? imp.devDependencies?.[name] ?? imp.optionalDependencies?.[name];
        // "1.2.3(peer@4.5.6)": the version before its peer suffix.
        return e ? String(e.version ?? e).replace(/\(.*$/, '') : null;
      },
    };
  }
  // yarn.lock: a block per "name@range" list, then its version. Yarn 1 writes
  // `version "1.2.3"`, later Yarns `version: 1.2.3` and `name@npm:range`.
  const byKey = new Map();
  for (const block of text.split(/\n(?=\S)/)) {
    const head = /^(.+):\s*$/m.exec(block);
    const version = /^\s+version:?\s+"?([^"\s]+)"?/m.exec(block);
    if (!head || !version) continue;
    for (const key of head[1].split(/,\s*/)) byKey.set(key.replace(/^"|"$/g, ''), version[1]);
  }
  return { file, version: (name, dir, range) => byKey.get(`${name}@${range}`) ?? byKey.get(`${name}@npm:${range}`) ?? null };
}

// Workspace folders, from package.json's workspaces (a list, or { packages })
// or pnpm-workspace.yaml's packages; a trailing /* lists that folder.
function workspaceDirs(root, pkg) {
  let globs = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages ?? [];
  const pnpm = path.join(root, 'pnpm-workspace.yaml');
  if (!globs.length && fs.existsSync(pnpm)) globs = parseYaml(fs.readFileSync(pnpm, 'utf8'))?.packages ?? [];
  return globs.flatMap((g) => {
    if (!g.endsWith('/*')) return [g];
    const base = g.slice(0, -2);
    try {
      return fs.readdirSync(path.join(root, base), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => `${base}/${e.name}`);
    } catch {
      return [];
    }
  });
}

// Every direct dependency across the root and its workspaces, once each,
// with the version its lockfile installs.
export function directDependencies(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = lockfileVersions(root);
  const workspaces = new Set();
  const names = new Map();
  for (const dir of ['.', ...workspaceDirs(root, pkg)]) {
    const file = path.join(root, dir, 'package.json');
    if (!fs.existsSync(file)) continue;
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (p.name) workspaces.add(p.name);
    for (const [name, range] of Object.entries({ ...p.dependencies, ...p.devDependencies })) {
      if (!names.has(name)) names.set(name, { range, where: [], dir });
      names.get(name).where.push(dir);
    }
  }
  return [...names]
    // A workspace package, or a local link (*, workspace:, file:), is the repo's own.
    .filter(([name, d]) => !workspaces.has(name) && !/^(\*|workspace:|file:|link:)/.test(String(d.range)))
    .map(([name, d]) => ({ name, where: d.where, installed: lock.version(name, d.dir, d.range), lockfile: lock.file }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---- Actions -----------------------------------------------------------------

// Each reference gh actions-lock has locked, with the commit it recorded; empty with no readable lockfile.
function lockedCommits(dir) {
  try {
    const deps = parseYaml(fs.readFileSync(path.join(dir, 'actions.lock'), 'utf8'))?.dependencies ?? {};
    return new Map(Object.entries(deps).map(([key, dep]) => [key, String(dep?.commit ?? '').replace(/^sha1-/, '')]));
  } catch {
    return new Map();
  }
}

// Every `uses: owner/repo[/path]@ref` in the workflows, once each.
export function actionPins(root) {
  const dir = path.join(root, '.github', 'workflows');
  const locked = lockedCommits(dir);
  const pins = new Map();
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /\.ya?ml$/.test(n)) : []) {
    for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/^\s*-?\s*uses:\s*([\w.-]+)\/([\w.-]+)(\/[^@\s]*)?@([^\s#]+)/gm)) {
      const key = `${m[1]}/${m[2]}${m[3] ?? ''}@${m[4]}`;
      // A locked tag reads as its recorded commit, which is what runs.
      if (!pins.has(key)) pins.set(key, { owner: m[1], repo: m[2], path: m[3] ?? '', ref: locked.get(key) || m[4], files: [] });
      pins.get(key).files.push(f);
    }
  }
  return [...pins.values()];
}

// The newest release at least ageDays old and its commit.
export async function eligibleRelease(exec, owner, repo, now, ageDays, cwd) {
  const releases = JSON.parse(await exec('gh', ['api', `repos/${owner}/${repo}/releases?per_page=30`], { cwd }));
  const cutoff = now.getTime() - ageDays * DAY;
  // Newest by version, not by date: an action may publish a backport to an
  // older major after its newest release (actions/checkout's v2 line).
  const ok = releases
    .filter((r) => !r.draft && !r.prerelease && parseVersion(r.tag_name) && Date.parse(r.published_at) <= cutoff)
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name));
  if (!ok.length) return null;
  const sha = JSON.parse(await exec('gh', ['api', `repos/${owner}/${repo}/commits/${encodeURIComponent(ok[0].tag_name)}`], { cwd })).sha;
  return { tag: ok[0].tag_name, sha, published: ok[0].published_at.slice(0, 10) };
}

// ---- CI minutes --------------------------------------------------------------

// Billed minutes of the runs on one commit: each job rounded up to the whole
// minute, as GitHub bills it.
export async function commitMinutes(exec, repo, sha, event, cwd) {
  const list = JSON.parse(await exec('gh', ['api', `repos/${repo}/actions/runs?head_sha=${sha}&event=${event}&per_page=50`], { cwd }));
  let minutes = 0;
  // One run at a time: the caller reads several commits at once, and that is its whole limit.
  for (const r of list.workflow_runs ?? []) {
    const jobs = JSON.parse(await exec('gh', ['api', `repos/${repo}/actions/runs/${r.id}/jobs?per_page=100`], { cwd }));
    for (const j of jobs.jobs ?? []) {
      const ms = Date.parse(j.completed_at ?? '') - Date.parse(j.started_at ?? '');
      if (Number.isFinite(ms) && ms > 0) minutes += Math.ceil(ms / 60_000);
    }
  }
  return { minutes, runs: (list.workflow_runs ?? []).length };
}

// ---- collect -------------------------------------------------------------------

// The Node version file setup-node reads (github.com/actions/setup-node,
// node-version-file), first found.
export const NODE_FILES = ['.nvmrc', '.node-version'];

// Each actions/setup-node step in the workflows and the Node it asks for:
// { label, spec, file } where file is a node-version-file to read. A value
// holding an Actions expression is the caller's (a reusable workflow's
// input), so that step is left out. Line-based, as actionPins is; a block or a
// flow mapping under with: both read.
export function setupNodeSteps(root) {
  const dir = path.join(root, '.github', 'workflows');
  if (!fs.existsSync(dir)) return [];
  const steps = [];
  for (const f of fs.readdirSync(dir).filter((x) => /\.ya?ml$/.test(x)).sort()) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const m = line.match(/^(\s*)(-\s+)?uses:\s*actions\/setup-node@/);
      if (!m) return;
      const item = m[2] ? m[1].length : m[1].length - 2; // the step's "- " column
      const step = setupNodeStep(lines, i, item, `${f}:${i + 1}`);
      if ([step.spec, step.file].some((v) => v && v.includes('${{'))) return;
      steps.push(step);
    });
  }
  return steps;
}

// One setup-node step read from the lines under it, up to the next line at or
// left of its "- " column.
function setupNodeStep(lines, i, item, label) {
  const step = { label, spec: null, file: null };
  for (const next of lines.slice(i + 1)) {
    if (!next.trim() || /^\s*#/.test(next)) continue;
    if (next.search(/\S/) <= item) break;
    for (const [key, value] of nodeKeys(next)) step[key === 'node-version' ? 'spec' : 'file'] = value.replace(/^["']|["']$/g, '');
  }
  return step;
}

// The node-version and node-version-file keys on one workflow line, as
// [key, value] pairs: a plain key, or a flow mapping, with: {node-version: 22, cache: npm}.
export function nodeKeys(line) {
  const kv = line.match(/^\s*(node-version|node-version-file):\s*(.*?)\s*(#.*)?$/);
  if (kv) return [[kv[1], kv[2]]];
  const flow = line.match(/^\s*with:\s*\{(.*)\}\s*(#.*)?$/);
  if (!flow) return [];
  return [...flow[1].matchAll(/(?:^|[{,\s])(node-version(?:-file)?)\s*:\s*("[^"]*"|'[^']*'|[^,]+)/g)].map((m) => [m[1], m[2].trim()]);
}

// The Node major a setup-node spec asks for: a number or range's first
// number, lts/* the newest LTS line, node or latest the newest release; null
// when it names none (the runner's own Node).
export function nodeMajor(spec, { line, newest }) {
  const v = String(spec ?? '').trim().toLowerCase();
  if (v === 'lts/*') return line;
  if (v === 'node' || v === 'latest' || v === 'current') return newest;
  const n = v.match(/^v?(\d+)/);
  return n ? Number(n[1]) : null;
}
