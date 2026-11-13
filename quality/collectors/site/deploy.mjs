// Deploy tab collector: how changes get into production, each metric a state
// now, the latest deploy, or the last 10 deploys, never an average over days,
// so each can be judged and fixed now. DORA's four keys, reshaped that way:
//
//   Speed    merges waiting now and the oldest one's wait; the latest
//            deploy's time from merge to live
//   Quality  whether the latest deploy failed; failures in the last 10
//            deploys; the latest failure's time to restore
//   Consumption  billed CI minutes of the push to main the latest deploy shipped
//
// N is 10 because Wrangler lists only the 10 most recent deployments.
//
// The deploy target is a Cloudflare Worker, read with Wrangler from
// params.worker_dir (default the repo root, when it holds a Wrangler config).
// Reads, all read-only: `wrangler deployments list` and `wrangler versions
// list` for the production Worker, the first-parent history of params.branch
// (default origin/main), and the bug issues that name a merged PR in a
// `Regressed-by: #N` line (`gh issue list`, one call). Wrangler needs a
// login, so CI marks every metric could_not_check and a --local collect
// fills them.
//
// A deploy's commit is its version tag (`main-<sha>`) or a sha in its
// message, else main's first-parent commit at the moment it was uploaded. A
// merge is live at the first later deploy whose commit contains it. Only
// merges touching params.deploy_paths count (default worker_dir, or every
// merge when that is the root): a docs-only merge ships nothing.
// A deploy failed when the next deploy rolled it back, or when it first
// shipped a PR an issue names as Regressed-by; it is restored at the rollback,
// or at the first deploy after that issue closed.
//
// With params.platform "pages", deploy-pages.mjs reads GitHub Pages deploys
// through the GitHub API instead, in CI as well; Wrangler is the default.
//
// Contract: quality/targets/deploy.json lists every metric id. collect()
// never throws for a missing tool, login or file, and never turns "could not
// read" into 0.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { ownRepo } from '../lib/paths.mjs';
import { failures, liveTimes, median, parseJsonList, parseLog, pushMinutes, resolveDeploys } from './deploy-lib.mjs';
import { collectPages } from './deploy-pages.mjs';

export const area = 'deploy';
// Reads the GitHub API: collect.mjs skips it under the API reserve (ci.json params.api_reserve).
export const githubApi = true;

const TARGETS = JSON.parse(fs.readFileSync(new URL('../../targets/deploy.json', import.meta.url), 'utf8'));
export const metricIds = TARGETS.map((t) => t.id);
// The template's own params, merged as the engine merges a file's: the
// defaults for a bare call. The engine passes the repo's merged params.
const TEMPLATE = Object.assign({}, ...TARGETS.map((t) => t.params ?? {}));

const HOUR = 36e5;
const DAY = 24 * HOUR;
const CI_REASON = 'needs a Wrangler login; refreshed by a --local collect';
// Wrangler's config files (developers.cloudflare.com/workers/wrangler/configuration/).
const WRANGLER_CONFIGS = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'];
const WRANGLER = 'npx wrangler deployments list --json and npx wrangler versions list --json (read-only, the 10 most recent of each)';
export const LAST_N = 10;

const run = promisify(execFile);
const defaultExec = async (cmd, args, opts = {}) => (await run(cmd, args, { maxBuffer: 64 << 20, timeout: 120_000, ...opts })).stdout;

const cnc = (reason, source) => ({ could_not_check: reason, source });
const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const iso = (ms) => new Date(ms).toISOString();

export { failures, liveTimes, median, parseJsonList, parseLog, pushMinutes, resolveDeploys } from './deploy-lib.mjs';

// Every Deploy metric: from GitHub Pages when params.platform is "pages",
// else from Wrangler (a --local collect only).
export async function collect({ root = '.', mode, exec = defaultExec, now = new Date(), params = TEMPLATE, gh } = {}) {
  if (params.platform === 'pages') return collectPages({ repo: await ownRepo(root, params, exec), gh, now, params });
  const all = (reason, source = WRANGLER) => Object.fromEntries(metricIds.map((id) => [id, cnc(reason, source)]));
  if (mode !== 'local') return all(CI_REASON);
  const dir = String(params.worker_dir || '.');
  const cwd = path.join(root, dir);
  if (!WRANGLER_CONFIGS.some((f) => fs.existsSync(path.join(cwd, f)))) return all(`no Wrangler config in ${dir}; set params.worker_dir on quality/targets/deploy.json to the Worker's folder`);
  const branch = String(params.branch || 'origin/main');
  const paths = params.deploy_paths ?? (dir === '.' ? [] : [dir]);
  const repo = await ownRepo(root, params, exec);
  const listed = await listDeployments(exec, cwd);
  if (listed.error) return all(listed.error);
  const log = await readHistory({ exec, root, branch, paths, deployments: listed.deployments });
  if (log.error) return all(log.error, `git log --first-parent ${branch}`);
  const ctx = makeContext({ exec, root, now, dir, branch, paths, repo, listed, log });
  return { ...waitingMetrics(ctx), ...leadMetric(ctx), ...(await buildMetric(ctx)), ...(await failureMetrics(ctx)) };
}

// Wrangler's deployments and versions, or { error } when it cannot list them.
async function listDeployments(exec, cwd) {
  try {
    const deployments = parseJsonList(await exec('npx', ['wrangler', 'deployments', 'list', '--json'], { cwd }));
    const versions = parseJsonList(await exec('npx', ['wrangler', 'versions', 'list', '--json'], { cwd }));
    if (!deployments.length) return { error: 'Wrangler lists no production deployment' };
    return { deployments, versions };
  } catch (err) {
    return { error: `wrangler could not list deployments (${String(err.message).split('\n')[0].slice(0, 160)}); run wrangler login where the collect runs` };
  }
}

// The first-parent history of the branch, and the shas of the commits that ship.
async function readHistory({ exec, root, branch, paths, deployments }) {
  try {
    // From a month before the oldest listed deploy, so it finds its commit.
    const oldestListed = Math.min(...deployments.map((d) => Date.parse(d.created_on)).filter(Number.isFinite));
    const from = `--since=${iso(oldestListed - 30 * DAY)}`;
    const log = async (...tail) => parseLog(await exec('git', ['log', '--first-parent', '--format=%H%x09%cI%x09%s', from, branch, ...tail], { cwd: root }));
    const history = await log();
    const shipping = paths.length ? new Set((await log('--', ...paths)).map((c) => c.sha)) : new Set(history.map((c) => c.sha));
    return { history, shipping };
  } catch (err) {
    return { error: `git log ${branch} failed: ${String(err.message).split('\n')[0]}` };
  }
}

// What every metric reads: the deploys, the merges and when each went live.
function makeContext({ exec, root, now, dir, branch, paths, repo, listed, log }) {
  const { history, shipping } = log;
  const deploys = resolveDeploys(listed.deployments, listed.versions, history);
  const merges = liveTimes(history.filter((c) => shipping.has(c.sha)), deploys, history);
  const code = deploys.filter((d) => !d.secret);
  const latest = code.at(-1);
  return {
    exec,
    root,
    now,
    nowMs: now.getTime(),
    readAt: now.toISOString(),
    repo,
    history,
    deploys,
    merges,
    code,
    latest,
    lastN: code.slice(-LAST_N),
    live: latest && latest.index !== null ? latest : null,
    shipsWhat: paths.length ? paths.join(', ') : 'any path',
    hours: (ms) => round(ms / HOUR),
    source: (what) => `${WRANGLER} in ${dir}; git log --first-parent ${branch}${paths.length ? ` -- ${paths.join(' ')}` : ''}; ${what}`,
    branch,
  };
}

const label = (m) => (m.pr ? `#${m.pr}` : m.sha.slice(0, 7));

// Speed, now: what main holds that production does not.
function waitingMetrics({ live, merges, history, hours, nowMs, readAt, source, shipsWhat, branch }) {
  const newest = merges[0];
  if (!live || !newest) {
    const reason = live ? `no merge touching ${shipsWhat} on ${branch}` : "the latest deploy's commit could not be found on main";
    return Object.fromEntries(['deploy.waiting_merges', 'deploy.oldest_waiting_hours'].map((id) => [id, cnc(reason, source('waiting merges'))]));
  }
  const waiting = merges.filter((m) => history.findIndex((c) => c.sha === m.sha) < live.index);
  const liveNote = `the latest code deploy, ${iso(live.at).slice(0, 16)}Z, holds ${live.commit} (${live.from === 'tag' ? 'its version tag' : 'main when it was uploaded'})`;
  return {
    'deploy.waiting_merges': {
      value: waiting.length,
      detail: waiting.map((m) => ({ label: label(m), value: hours(nowMs - m.at), unit: 'h' })),
      source: source(`merges on main touching ${shipsWhat} that production does not hold now; detail is hours each has waited; ${liveNote}`),
      read_at: readAt,
    },
    'deploy.oldest_waiting_hours': {
      value: waiting.length ? hours(nowMs - waiting.at(-1).at) : 0,
      source: source(`hours since the oldest merge production does not hold was merged, 0 when none waits; ${liveNote}`),
      read_at: readAt,
    },
  };
}

const shippedBy = (merges, id) => merges.filter((m) => m.deploy === id);

// Speed: the latest deploy that shipped merges, its slowest merge.
function leadMetric({ code, merges, hours, readAt, source, shipsWhat }) {
  const lastShip = [...code].reverse().find((d) => shippedBy(merges, d.id).length);
  if (!lastShip) return { 'deploy.latest_lead_hours': cnc(`none of the last ${code.length} deploys shipped a merge touching ${shipsWhat}`, source('lead time')) };
  const shipped = shippedBy(merges, lastShip.id);
  return {
    'deploy.latest_lead_hours': {
      value: hours(Math.max(...shipped.map((m) => m.live_at - m.at))),
      detail: shipped.slice(0, 12).map((m) => ({ label: label(m), value: hours(m.live_at - m.at), unit: 'h' })),
      source: source(`the latest deploy that shipped a merge, ${iso(lastShip.at).slice(0, 16)}Z (${lastShip.commit}): hours from its earliest merge to the deploy`),
      read_at: readAt,
    },
  };
}

// Consumption: the billed Actions minutes of the push to main the latest
// deploy shipped. Workers Builds minutes are not read.
async function buildMetric({ live, repo, exec, root, history, readAt }) {
  const ciSource = `latest: the workflow runs the push to main of the latest production deploy's commit started (gh api actions/runs?head_sha=&event=push, then runs/{id}/jobs), each job rounded up to the whole minute as GitHub bills it (docs.github.com/en/billing/managing-billing-for-github-actions/about-billing-for-github-actions); Workers Builds minutes are not read`;
  const id = 'deploy.latest_build_minutes';
  if (!live) return { [id]: cnc("the latest deploy's commit could not be found on main", ciSource) };
  try {
    if (!repo) throw new Error('no GitHub repo: set params.repo, or give the checkout a GitHub origin');
    const ci = await pushMinutes(exec, repo, history[live.index].sha, root);
    if (!ci.runs.length) return { [id]: cnc(`no push run on main for ${live.commit}`, ciSource) };
    return { [id]: { value: ci.minutes, detail: ci.runs.map((r) => ({ label: r.name, value: r.minutes, unit: 'min' })), source: `${ciSource}; the deploy of ${iso(live.at).slice(0, 16)}Z (${live.commit})`, read_at: readAt } };
  } catch (err) {
    return { [id]: cnc(`gh api failed: ${String(err.message).split('\n')[0].slice(0, 160)}`, ciSource) };
  }
}

// Quality: the latest deploy, the last 10, the latest failure's restore.
async function failureMetrics(ctx) {
  const { repo, exec, root, source } = ctx;
  let issues = null;
  let issueError = '';
  try {
    if (!repo) throw new Error('no GitHub repo: set params.repo, or give the checkout a GitHub origin');
    issues = JSON.parse(await exec('gh', ['issue', 'list', '-R', repo, '--state', 'all', '--search', '"Regressed-by" in:body', '--limit', '200', '--json', 'number,body,closedAt'], { cwd: root }));
  } catch (err) {
    issueError = String(err.message).split('\n')[0].slice(0, 160);
  }
  const failSource = source(`a deploy failed when the next one rolled it back or when it first shipped a PR that a bug issue names in a "Regressed-by: #N" line (gh issue list -R ${repo || '<repo>'} --search "Regressed-by" in:body); restored at the rollback or at the first deploy after the issue closed`);
  if (!issues) {
    const reason = `gh issue list failed (${issueError}); without the Regressed-by issues a failure would read as none`;
    return Object.fromEntries(['deploy.latest_failed', 'deploy.failure_rate_last10', 'deploy.latest_restore_hours'].map((id) => [id, cnc(reason, failSource)]));
  }
  const failed = failures(ctx.deploys, ctx.merges, issues);
  const inLast = failed.filter((f) => ctx.lastN.some((d) => d.id === f.deploy.id));
  return {
    'deploy.latest_failed': latestFailed(ctx, failed, failSource),
    'deploy.failure_rate_last10': failureRate(ctx, failed, inLast, failSource),
    'deploy.latest_restore_hours': latestRestore(ctx, inLast.at(-1), failSource),
  };
}

// The latest deploy can only be judged once the next deploy or an issue
// says otherwise; until then it reads as not failed, as DORA counts it.
function latestFailed({ latest, readAt }, failed, failSource) {
  const value = failed.some((f) => f.deploy.id === latest.id) || latest.rollback ? 1 : 0;
  return {
    value,
    detail: [{ label: `${iso(latest.at).slice(0, 16).replace('T', ' ')} ${latest.commit ?? ''}`, value, unit: '' }],
    source: `${failSource}; 1 when the latest code deploy failed or was itself a rollback`,
    read_at: readAt,
  };
}

function failureRate({ lastN, merges, hours, readAt }, failed, inLast, failSource) {
  const failedIds = new Map(failed.map((f) => [f.deploy.id, f]));
  return {
    value: round((inLast.length / lastN.length) * 100),
    detail: lastN.map((d) => {
      const shipped = shippedBy(merges, d.id);
      const f = failedIds.get(d.id);
      return {
        label: iso(d.at).slice(0, 16).replace('T', ' '),
        value: shipped.length,
        unit: 'merges',
        commit: d.commit,
        commit_from: d.from,
        lead_hours: shipped.length ? round(median(shipped.map((m) => (m.live_at - m.at) / HOUR))) : null,
        rollback: d.rollback,
        failed: f ? f.why : null,
        restore_hours: f && f.restored ? hours(f.restored - d.at) : null,
      };
    }),
    source: `${failSource}; the last ${lastN.length} code deploys (secret-only deploys left out), N = ${LAST_N} because Wrangler lists only the 10 most recent`,
    read_at: readAt,
  };
}

function latestRestore({ lastN, hours, nowMs, readAt }, lastFail, failSource) {
  if (!lastFail) return cnc(`none of the last ${lastN.length} deploys failed, so there is nothing to restore`, failSource);
  if (lastFail.restored !== null) {
    const h = hours(lastFail.restored - lastFail.deploy.at);
    return { value: h, detail: [{ label: `${iso(lastFail.deploy.at).slice(0, 10)} ${lastFail.deploy.commit ?? ''}: ${lastFail.why}`, value: h, unit: 'h' }], source: failSource, read_at: readAt };
  }
  const h = hours(nowMs - lastFail.deploy.at);
  return { value: h, detail: [{ label: `${lastFail.why}, not restored yet`, value: h, unit: 'h' }], source: `${failSource}; not restored yet, so the hours run to now`, read_at: readAt };
}
