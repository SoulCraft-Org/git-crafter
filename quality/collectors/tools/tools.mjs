// Tools tab collector: is every package, GitHub Action and toolchain on the
// latest version it may take? Each metric is a state now or the last N
// events, never an average over days.
//
//   Quality      direct dependencies on the newest eligible version, majors
//                behind, third-party Actions pinned to the newest eligible
//                release, CI's Node on the current LTS line
//   Speed        days the oldest eligible update has waited, open dependency
//                PRs and the oldest one's age
//   Consumption  CI minutes on the latest merged dependency-update PR, and
//                the latest main CI run's install time
//
// "Eligible" is the release-age rule: a version counts once it is at least
// params.release_age_days old (default 14), so "latest" means the newest
// stable release that old. A version installed before it is eligible is "too
// new", not current.
//
// Reads, all read-only, whichever of these the repo has: package.json files
// with the lockfile that pins them (npm's package-lock.json or
// npm-shrinkwrap.json, pnpm's pnpm-lock.yaml, Yarn's yarn.lock), `npm view
// <name> time --json` per direct dependency, the workflows' `uses:` pins,
// `gh api` for each action's releases and for the dependency PRs and their
// CI runs, each workflow's actions/setup-node version (node-version, or the
// node-version-file it names) against Node's release index
// (nodejs.org/dist/index.json), else .nvmrc or .node-version. Security alert counts stay on the Security
// tab. It runs in CI and locally alike.
//
// Contract: quality/targets/tools.json lists every metric id. collect()
// never throws for a missing tool, token or file, and never turns "could not
// read" into 0.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { mapLimit } from '../ci/ci-core.mjs';
import { ownRepo } from '../lib/paths.mjs';
import { actionPins, adopterPins, commitMinutes, compareVersions, cooledTag, DAY, directDependencies, eligibleRelease, heldMajors, judge, lockfileVersions, nodeMajor, parseVersion, pinTag, round, sameMajor, setupNodeSteps, versionTags, NODE_FILES } from './tools-lib.mjs';

export * from './tools-lib.mjs';

export const area = 'tools';
// Reads the GitHub API: collect.mjs skips it under the API reserve (ci.json params.api_reserve).
export const githubApi = true;

const TARGETS = JSON.parse(fs.readFileSync(new URL('../../targets/tools.json', import.meta.url), 'utf8'));
export const metricIds = TARGETS.map((t) => t.id);
// The template's own params, merged as the engine merges a file's: the
// defaults for a bare call. The engine passes the repo's merged params.
const TEMPLATE = Object.assign({}, ...TARGETS.map((t) => t.params ?? {}));

const run = promisify(execFile);
const defaultExec = async (cmd, args, opts = {}) => (await run(cmd, args, { maxBuffer: 64 << 20, timeout: 120_000, ...opts })).stdout;
const defaultFetch = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
};

const cnc = (reason, source) => ({ could_not_check: reason, source });
const firstLine = (err) => String(err?.message ?? err).split('\n')[0].slice(0, 160);

// Every Tools metric, from the repo's packages and their public registries.
export async function collect({ root = '.', mode, exec = defaultExec, fetchJson = defaultFetch, now = new Date(), params = TEMPLATE } = {}) {
  void mode; // CI and a local run read the same public sources.
  const ageDays = Number(params.release_age_days ?? 14);
  const repo = await ownRepo(root, params, exec);
  const c = {
    root,
    exec,
    fetchJson,
    now,
    params,
    repo,
    ageDays,
    label: String(params.dependency_label || 'dependencies'),
    branch: String(params.branch || 'main'),
    readAt: now.toISOString(),
    rule: `the newest stable release at least ${ageDays} days old (params.release_age_days)`,
    noRepo: 'no GitHub repo: set params.repo, or give the checkout a GitHub origin',
  };
  // The groups read different sources, so they go out at once: one after another they held the collect for 40.1 s
  // (pages.yml run 43110227533, 2026-11-11). Only the CI minutes wait, on the merged PRs the PR read returns.
  // Spreading in this fixed order keeps the output the same whichever group answers first.
  const prsThenMinutes = dependencyPrMetrics(c).then(async (prs) => ({ prs, minutes: await ciMinutesMetric(c, prs.merged) }));
  const [deps, actions, node, adopters, { prs, minutes }, install] = await Promise.all([
    dependencyMetrics(c),
    actionMetric(c),
    nodeMetric(c),
    adopterMetric(c),
    prsThenMinutes,
    installMetric(c),
  ]);
  return { ...deps, ...actions, ...node, ...adopters, ...prs.metrics, ...minutes, ...install };
}

// GitHub reads at once inside one group. Four groups read GitHub (action pins, adopters, PRs then their CI
// minutes, the install run), so this collector has at most READS * GITHUB_GROUPS gh calls in flight, 16 of
// GitHub's 100 concurrent requests (docs.github.com, "Rate limits for the REST API", read 2026-11-11).
export const READS = 4;
export const GITHUB_GROUPS = 4;

const failAll = (ids, reason, source) => Object.fromEntries(ids.map((id) => [id, cnc(reason, source)]));
const share = (rows, current) => round((current.length / rows.length) * 100);

// Quality and speed: the direct dependencies.
const DEP_IDS = ['tools.deps_latest_share', 'tools.majors_behind', 'tools.oldest_update_wait_days'];

async function dependencyMetrics(c) {
  let npmSource = `package.json (root and workspaces) and its lockfile against npm view <name> time --json; eligible is ${c.rule}`;
  let deps;
  try {
    deps = directDependencies(c.root);
    npmSource = npmSource.replace('its lockfile', deps[0]?.lockfile ?? 'its lockfile');
  } catch (err) {
    return failAll(DEP_IDS, `package.json or its lockfile unreadable: ${firstLine(err)}`, npmSource);
  }
  let held = new Set();
  try {
    held = heldMajors(c.root);
  } catch (err) {
    npmSource += `; .github/dependabot.yml unreadable, so no major is held: ${firstLine(err)}`;
  }
  // One npm view per dependency, all at once; rows keep the name order.
  const rows = await Promise.all(deps.map((d) => readDependency(d, held, c)));
  const judged = rows.filter((r) => r.status !== 'not read');
  const unread = rows.filter((r) => r.status === 'not read').map((r) => r.label);
  const note = unread.length ? `; npm view failed for ${unread.join(', ')}` : '';
  if (!judged.length) return failAll(DEP_IDS, `npm view answered for no dependency${note}`, npmSource);
  return depMetrics({ rows, judged, held, c, npmSource, note });
}

async function readDependency(d, held, { exec, now, ageDays }) {
  try {
    let times = JSON.parse(await exec('npm', ['view', d.name, 'time', '--json'], { cwd: os.tmpdir() }));
    if (Array.isArray(times)) times = times[0];
    const where = d.where.join(', ');
    if (!held.has(d.name)) return { ...judge(d.name, d.installed, times ?? {}, now, ageDays), where };
    const next = judge(d.name, d.installed, times ?? {}, now, ageDays).eligible;
    return { ...judge(d.name, d.installed, sameMajor(times ?? {}, d.installed), now, ageDays), where, held: `major ${parseVersion(next)?.[0] ?? '?'} held by a Dependabot ignore` };
  } catch (err) {
    return { label: d.name, installed: d.installed, status: 'not read', value: null, where: d.where.join(', '), note: firstLine(err) };
  }
}

function depMetrics({ rows, judged, held, c, npmSource, note }) {
  const { readAt, ageDays } = c;
  const behind = judged.filter((r) => r.majors_behind > 0);
  const waiting = judged.filter((r) => r.status === 'behind').sort((a, b) => b.waiting_days - a.waiting_days);
  return {
    'tools.deps_latest_share': {
      value: share(judged, judged.filter((r) => r.status === 'current')),
      detail: rows,
      source: `${npmSource}; ${judged.length} of ${rows.length} direct dependencies read${note}`,
      read_at: readAt,
    },
    'tools.majors_behind': {
      value: behind.length,
      detail: behind.map((r) => ({ label: `${r.label} ${r.installed} → ${r.eligible}`, value: r.majors_behind, unit: 'majors' })),
      source: `${npmSource}; direct dependencies whose eligible release is a newer major, less a major held by a Dependabot ignore (${[...held].join(', ') || 'none'})${note}`,
      read_at: readAt,
    },
    'tools.oldest_update_wait_days': {
      value: waiting.length ? waiting[0].waiting_days : 0,
      detail: waiting.slice(0, 12).map((r) => ({ label: `${r.label} ${r.installed} → ${r.eligible}`, value: r.waiting_days, unit: 'days' })),
      source: `${npmSource}; days since the first update past each installed version cleared the ${ageDays}-day rule, the longest; 0 when none waits${note}`,
      read_at: readAt,
    },
  };
}

// Quality: third-party Actions pinned to the newest eligible release. The
// repo's own owner's actions are left out by default: they have no releases.
async function actionMetric({ root, exec, now, ageDays, params, repo, rule, readAt }) {
  const own = new Set(params.own_action_owners ?? [repo.split('/')[0]].filter(Boolean));
  const pins = actionPins(root).filter((p) => !own.has(p.owner));
  const actionSource = `uses: pins in .github/workflows against gh api repos/<owner>/<repo>/releases (${rule}) and the release tag's commit; actions owned by ${[...own].join(', ') || 'no one'} (params.own_action_owners, default the repo's owner) are left out, as they have no releases`;
  const id = 'tools.actions_latest_share';
  if (!pins.length) return { [id]: cnc('no third-party action pin in .github/workflows', actionSource) };
  const rows = await mapLimit(pins, READS, (p) => readPin(p, { exec, now, ageDays, root }));
  const read = rows.filter((r) => r.status !== 'not read');
  if (!read.length) return { [id]: cnc(`no action's releases could be read (${rows[0]?.note ?? ''})`, actionSource) };
  return { [id]: { value: share(read, read.filter((r) => r.status === 'current')), detail: rows, source: `${actionSource}; ${read.length} of ${rows.length} read`, read_at: readAt } };
}

async function readPin(p, { exec, now, ageDays, root }) {
  const label = `${p.owner}/${p.repo}${p.path}`;
  try {
    const rel = await eligibleRelease(exec, p.owner, p.repo, now, ageDays, root);
    const status = !rel ? 'not read' : p.ref === rel.sha ? 'current' : /^[0-9a-f]{40}$/.test(p.ref) ? 'behind' : 'not a SHA';
    return { label, value: status === 'current' ? 1 : 0, unit: '', pinned: p.ref.slice(0, 12), eligible: rel ? `${rel.tag} (${rel.sha.slice(0, 12)}, ${rel.published})` : null, status, files: p.files.join(', ') };
  } catch (err) {
    return { label, value: null, unit: '', pinned: p.ref.slice(0, 12), eligible: null, status: 'not read', note: firstLine(err) };
  }
}

// One setup-node step as a row: its label and the Node major it asks for.
function nodeRow(st, { root, line, newest }) {
  const readFile = (f) => fs.readFileSync(path.join(root, f), 'utf8').trim().replace(/^v/, '');
  const spec = st.spec ?? (st.file ? readFile(st.file) : null);
  const what = st.spec ? `node-version ${st.spec}` : st.file ? `${st.file} ${spec}` : "no version (the runner's Node)";
  return { label: `${st.label}: ${what}`, value: nodeMajor(spec, { line, newest }), unit: '' };
}

// Quality: CI's Node version against the current LTS line: every
// setup-node step in the workflows, else the version file.
async function nodeMetric({ root, fetchJson, readAt }) {
  const nodeFile = NODE_FILES.find((f) => fs.existsSync(path.join(root, f))) ?? NODE_FILES[0];
  const steps = setupNodeSteps(root);
  const nodeSource = steps.length
    ? `each actions/setup-node step's node-version or node-version-file in .github/workflows (${steps.length}) against https://nodejs.org/dist/index.json, the newest line with an LTS codename`
    : `${nodeFile} (setup-node's node-version-file) against https://nodejs.org/dist/index.json, the newest line with an LTS codename`;
  const id = 'tools.node_lts';
  try {
    const index = await fetchJson('https://nodejs.org/dist/index.json');
    const majorOf = (r) => Number(String(r.version).replace(/^v/, '').split('.')[0]);
    const line = Math.max(...index.filter((r) => r.lts).map(majorOf));
    const newest = Math.max(...index.map(majorOf));
    const rows = steps.length ? steps.map((st) => nodeRow(st, { root, line, newest })) : [nodeRow({ label: nodeFile, file: nodeFile }, { root, line, newest })];
    if (!Number.isFinite(line) || !rows.every((r) => r.value === null || Number.isFinite(r.value))) return { [id]: cnc(`could not read a Node major from ${rows.map((r) => r.label).join('; ')} or the index`, nodeSource) };
    return { [id]: { value: rows.every((r) => r.value === line) ? 1 : 0, detail: [...rows, { label: 'Current LTS line', value: line, unit: '' }], source: nodeSource, read_at: readAt } };
  } catch (err) {
    return { [id]: cnc(`${firstLine(err)}`, nodeSource) };
  }
}

// One adopter as a row. The page prints a row's label and value only, so the
// label carries the pin, the tag it is judged against and that tag's age.
async function readAdopter(a, { repo, tags, bar, exec, root }) {
  try {
    const pins = await adopterPins(a, repo, exec, root);
    if (!pins.length) return { label: a, value: null, status: 'not read', note: `no uses: of ${repo}` };
    const named = pins.map((p) => pinTag(p.ref, tags));
    // A pin no version tag names has no place in the version order, so it is never current.
    const current = named.every((n) => n && compareVersions(n, bar.name) >= 0);
    const pinned = [...new Set(pins.map((p, i) => named[i] ?? `${p.ref.slice(0, 12)} (no tag)`))].join(', ');
    return { label: `${a}: pin ${pinned}, judged against ${bar.name}, ${bar.age_days} days old`, value: current ? 1 : 0, unit: '', status: current ? 'current' : 'behind', adopter: a, pinned, judged_against: bar.name, tag_age_days: bar.age_days };
  } catch (err) {
    return { label: a, value: null, status: 'not read', note: firstLine(err) };
  }
}

// params.adopters and params.adopter_cooldown_days, and why they cannot be
// judged (null when they can).
function adopterParams(params) {
  const adopters = Array.isArray(params.adopters) ? params.adopters.filter((a) => /^[\w.-]+\/[\w.-]+$/.test(a)) : [];
  const cooldown = Number(params.adopter_cooldown_days ?? 7);
  const none = adopters.length ? null : 'no adopting repos: list them as owner/name in params.adopters';
  return { adopters, cooldown, why: none ?? (cooldown >= 0 ? null : 'params.adopter_cooldown_days must be 0 or more days') };
}

// Quality: the repos that adopt this one (params.adopters), each pinned at or
// above the bar: this repo's newest tag old enough for one weekly Dependabot
// run to have offered it. The newest tag itself is a bar no weekly run holds,
// so it could not reach the goal. With no tag that old there is no bar, and
// a 100 would measure nothing: the metric is not read.
async function adopterMetric({ params, repo, exec, root, now, readAt, noRepo }) {
  const { adopters, cooldown, why } = adopterParams(params);
  const adoptSource = `each repo in params.adopters: its .github/workflows uses: pins of ${repo || '<repo>'} (gh api contents) against this repo's newest tag at least ${cooldown} days old (params.adopter_cooldown_days, default 7: one weekly Dependabot run), aged by its commit's date (gh api tags and git/commits)`;
  const id = 'tools.adopters_latest_share';
  if (!repo) return { [id]: cnc(noRepo, adoptSource) };
  if (why) return { [id]: cnc(why, adoptSource) };
  try {
    const tags = await versionTags(repo, exec, root);
    if (!tags.length) throw new Error(`${repo} has no version tag`);
    const bar = await cooledTag(tags, { repo, exec, cwd: root, now, ageDays: cooldown });
    if (!bar) return { [id]: cnc(`no version tag of ${repo} is ${cooldown} days old yet; the first, ${tags[0].name}, is younger`, adoptSource) };
    const rows = await mapLimit(adopters, READS, (a) => readAdopter(a, { repo, tags, bar, exec, root }));
    const read = rows.filter((r) => r.status !== 'not read');
    if (!read.length) return { [id]: cnc(`no adopter's pins could be read (${rows[0]?.note ?? ''})`, adoptSource) };
    return { [id]: { value: share(read, read.filter((r) => r.status === 'current')), detail: rows, source: `${adoptSource}; that tag: ${bar.name}, ${bar.age_days} days old; newest ${tags.at(-1).name}; ${read.length} of ${rows.length} read`, read_at: readAt } };
  } catch (err) {
    return { [id]: cnc(firstLine(err), adoptSource) };
  }
}

// Speed: open dependency PRs and the oldest one's age. Also reads the merged
// ones, which the CI minutes metric needs (null when the read failed).
async function dependencyPrMetrics({ repo, label, exec, root, now, params, readAt, noRepo }) {
  const prSource = `gh pr list -R ${repo || '<repo>'} --label ${label} (params.dependency_label; Dependabot's default label)`;
  const metrics = {};
  let merged = null;
  try {
    if (!repo) throw new Error(noRepo);
    const open = JSON.parse(await exec('gh', ['pr', 'list', '-R', repo, '--state', 'open', '--label', label, '--limit', '50', '--json', 'number,createdAt,title'], { cwd: root }));
    const ages = open.map((p) => ({ label: `#${p.number} ${p.title}`.slice(0, 80), value: Math.floor((now.getTime() - Date.parse(p.createdAt)) / DAY), unit: 'days' })).sort((a, b) => b.value - a.value);
    metrics['tools.open_dependency_prs'] = { value: open.length, detail: ages, source: `${prSource} --state open`, read_at: readAt };
    metrics['tools.oldest_dependency_pr_days'] = { value: ages.length ? ages[0].value : 0, detail: ages.slice(0, 12), source: `${prSource} --state open; days since the oldest opened, 0 when none is open`, read_at: readAt };
    merged = JSON.parse(await exec('gh', ['pr', 'list', '-R', repo, '--state', 'merged', '--label', label, '--limit', String(params.last_n ?? 10), '--json', 'number,headRefOid,title,mergedAt'], { cwd: root }));
  } catch (err) {
    for (const id of ['tools.open_dependency_prs', 'tools.oldest_dependency_pr_days']) metrics[id] ??= cnc(`gh pr list failed: ${firstLine(err)}`, prSource);
  }
  return { metrics, merged };
}

// Consumption: CI minutes on the latest merged dependency-update PR, read now;
// the last N beside it, newest first.
async function ciMinutesMetric({ params, label, repo, exec, root, readAt }, merged) {
  const lastN = Number(params.last_n ?? 10);
  const ciSource = `the last ${lastN} merged PRs labeled ${label}: gh api actions/runs?head_sha=<PR head>&event=pull_request and runs/{id}/jobs, each job rounded up to the whole minute as GitHub bills it (docs.github.com/en/billing/managing-billing-for-github-actions/about-billing-for-github-actions); N = ${lastN} (params.last_n)`;
  const id = 'tools.latest_dependency_pr_ci_minutes';
  if (!merged) return { [id]: cnc('gh pr list failed', ciSource) };
  if (!merged.length) return { [id]: cnc(`no merged PR labeled ${label} yet`, ciSource) };
  try {
    const newest = [...merged].sort((a, b) => (Date.parse(b.mergedAt) || 0) - (Date.parse(a.mergedAt) || 0));
    const per = await mapLimit(newest, READS, async (p) => ({ label: `#${p.number}`, value: (await commitMinutes(exec, repo, p.headRefOid, 'pull_request', root)).minutes, unit: 'min' }));
    const at = newest[0].mergedAt ? `, merged ${newest[0].mergedAt.slice(0, 10)}` : '';
    return { [id]: { value: per[0].value, detail: per, source: `${ciSource}; the latest, #${newest[0].number}${at}, and the rest beside it`, read_at: readAt } };
  } catch (err) {
    return { [id]: cnc(`gh api failed: ${firstLine(err)}`, ciSource) };
  }
}

// The install steps of a successful push run, seconds each, in the newest of
// the 5 newest runs that has one; at most one jobs call per run.
async function newestInstall({ repo, wf, branch, exec, root }) {
  const INSTALL = /\b(npm ci|pnpm install|yarn install)\b/i;
  const runs = JSON.parse(await exec('gh', ['api', `repos/${repo}/actions/${wf ? `workflows/${wf}/` : ''}runs?branch=${branch}&event=push&status=success&per_page=5`], { cwd: root }));
  for (const r of (runs.workflow_runs ?? []).slice(0, 5)) {
    const jobs = JSON.parse(await exec('gh', ['api', `repos/${repo}/actions/runs/${r.id}/jobs?per_page=100`], { cwd: root }));
    const steps = (jobs.jobs ?? []).flatMap((j) => (j.steps ?? []).filter((s) => INSTALL.test(s.name ?? '') && s.conclusion === 'success').map((s) => ({ job: j.name, secs: (Date.parse(s.completed_at) - Date.parse(s.started_at)) / 1000 }))).filter((s) => Number.isFinite(s.secs));
    if (steps.length) return { runs, found: { run: r, steps } };
  }
  return { runs, found: null };
}

// Consumption: the install step's time in the latest main CI run: of
// params.install_workflow, or else of the newest push run that has one.
async function installMetric({ params, repo, branch, exec, root, readAt, noRepo }) {
  const wf = String(params.install_workflow || '');
  const installSource = `latest: the newest successful push run of ${wf || 'any workflow'} on ${branch} with an install step (npm ci, pnpm install or yarn install), the slowest such step (gh api actions/${wf ? `workflows/${wf}/` : ''}runs and runs/{id}/jobs)`;
  const id = 'tools.npm_ci_seconds';
  try {
    if (!repo) throw new Error(noRepo);
    const { runs, found } = await newestInstall({ repo, wf, branch, exec, root });
    if (found) return { [id]: { value: Math.round(Math.max(...found.steps.map((s) => s.secs))), detail: found.steps.map((s) => ({ label: s.job, value: Math.round(s.secs), unit: 's' })), source: `${installSource}; run ${found.run.id} (${String(found.run.head_sha).slice(0, 7)})`, read_at: readAt } };
    return { [id]: cnc(runs.workflow_runs?.length ? `none of the newest ${Math.min(runs.workflow_runs.length, 5)} successful push runs has an install step` : `no successful push run on ${branch}`, installSource) };
  } catch (err) {
    return { [id]: cnc(`gh api failed: ${firstLine(err)}`, installSource) };
  }
}
