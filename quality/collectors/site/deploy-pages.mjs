// The Deploy tab's GitHub Pages reader: the same seven metrics deploy.mjs
// reads from Wrangler, for a repo that ships with GitHub Pages. deploy.mjs
// calls it when params.platform is "pages".
//
// Reads, all read-only, through the gh client (github-core.mjs ghClient):
//   repos/{repo}/deployments?environment=github-pages   the newest deploys
//   repos/{repo}/deployments/{id}/statuses              each one's outcome
//   repos/{repo}/compare/{base}...{head}                the merges each shipped,
//                                                       and those still waiting
//   repos/{repo}/actions/runs?head_sha=&event=push      every run on the push,
//   repos/{repo}/actions/runs/{id}/jobs                 then their billed minutes
//
// A deploy's outcome is its newest status: success, or failure and error.
// There is no rollback detection: a failure is a failed github-pages
// deployment, restored at the next successful one. A
// deploy still queued or in progress is left out until it ends. A deploy
// shipped the commits between the previous successful deploy and its own
// sha; the repo merges by squash, so each commit on main is one merge. A
// failed deploy is restored at the next successful one. Every merge counts
// as shipping: the Pages workflow's own path filter decides what deploys.
//
// Never throws: a failed read becomes could_not_check, never 0.

import { pushMinutes } from './deploy-lib.mjs';
import { ghClient } from '../github/github-core.mjs';

const ENVIRONMENT = 'github-pages';
const LAST_N = 10;
const HOUR = 36e5;
const ENDED = new Set(['success', 'failure', 'error']);
const IDS = ['deploy.waiting_merges', 'deploy.oldest_waiting_hours', 'deploy.latest_lead_hours', 'deploy.latest_failed', 'deploy.failure_rate_last10', 'deploy.latest_restore_hours', 'deploy.latest_build_minutes'];

const cnc = (reason, source) => ({ could_not_check: reason, source });
const round = (n) => Math.round(n * 10) / 10;
const hours = (ms) => round(ms / HOUR);
const stamp = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
const firstLine = (err) => String(err?.message ?? err).split('\n')[0].slice(0, 160);

// The seven Deploy metrics for a GitHub Pages repo. gh is a github-core
// client; params.branch (default the repo's default branch, "origin/" dropped)
// names the branch merges wait on. building is the commit this run builds
// (GITHUB_SHA in Actions): its deploy ships it, so it does not wait.
export async function collectPages({ repo, gh = ghClient(), now = new Date(), params = {}, building = process.env.GITHUB_SHA ?? null } = {}) {
  const source = (what) => `GitHub Pages: gh api repos/${repo || '<repo>'}/deployments?environment=${ENVIRONMENT} and each deploy's statuses; ${what}`;
  const all = (reason) => Object.fromEntries(IDS.map((id) => [id, cnc(reason, source('every Deploy metric'))]));
  if (!repo) return all('no GitHub repo: set params.repo, or give the checkout a GitHub origin');
  let deploys;
  try {
    deploys = await readDeploys(gh, repo);
  } catch (err) {
    return all(`gh api failed: ${firstLine(err)}`);
  }
  if (!deploys.length) return all(`no ended deploy in the ${ENVIRONMENT} environment`);
  const ctx = { gh, repo, deploys, nowMs: now.getTime(), readAt: now.toISOString(), source, params, building };
  await shippedMerges(ctx);
  return { ...(await waiting(ctx)), ...lead(ctx), ...failures(ctx), ...(await buildMinutes(ctx)) };
}

// The ended Pages deploys, oldest first: { id, sha, at, ok, ended }.
export async function readDeploys(gh, repo) {
  const list = await gh.rest(`repos/${repo}/deployments?environment=${ENVIRONMENT}&per_page=${LAST_N * 3}`);
  const out = [];
  for (const d of list ?? []) {
    const statuses = await gh.rest(`repos/${repo}/deployments/${d.id}/statuses?per_page=10`);
    const last = (statuses ?? []).find((s) => ENDED.has(s.state));
    if (last) out.push({ id: d.id, sha: d.sha, at: Date.parse(d.created_at), ended: Date.parse(last.created_at), ok: last.state === 'success' });
  }
  return out.sort((a, b) => a.at - b.at);
}

// The merges between two shas, oldest first: { sha, at }.
async function between(gh, repo, base, head) {
  const c = await gh.rest(`repos/${repo}/compare/${base}...${head}`);
  return (c?.commits ?? []).map((x) => ({ sha: x.sha, at: Date.parse(x.commit?.committer?.date) }));
}

// Each successful deploy's merges: the commits since the previous successful
// one. The oldest listed success has no base, so it carries null.
async function shippedMerges(ctx) {
  let base = null;
  for (const d of ctx.deploys) {
    if (!d.ok) continue;
    d.merges = null;
    if (base && base !== d.sha) {
      try {
        d.merges = await between(ctx.gh, ctx.repo, base, d.sha);
      } catch {
        d.merges = null;
      }
    } else if (base === d.sha) d.merges = [];
    base = d.sha;
  }
}

// Speed, now: merges on the branch that the latest successful deploy lacks.
// A build on the branch deploys its commit and every merge before it, so
// those leave the count; on a pull request the commit is not on the branch.
async function waiting({ gh, repo, deploys, nowMs, readAt, source, params, building }) {
  const ids = ['deploy.waiting_merges', 'deploy.oldest_waiting_hours'];
  const live = deploys.findLast((d) => d.ok);
  const src = source('gh api repos/{repo}/compare/{live sha}...{branch}: merges production does not hold now, less the commit this run deploys and those before it');
  if (!live) return Object.fromEntries(ids.map((id) => [id, cnc('no successful Pages deploy to compare main with', src)]));
  try {
    const branch = String(params.branch || '').replace(/^origin\//, '') || (await gh.rest(`repos/${repo}`)).default_branch;
    const all = await between(gh, repo, live.sha, branch);
    const ahead = all.slice(all.findIndex((m) => m.sha === building) + 1);
    const detail = ahead.map((m) => ({ label: m.sha.slice(0, 7), value: hours(nowMs - m.at), unit: 'h' }));
    return {
      'deploy.waiting_merges': { value: ahead.length, detail, source: src, read_at: readAt },
      'deploy.oldest_waiting_hours': { value: ahead.length ? hours(nowMs - ahead[0].at) : 0, source: `${src}; hours since the oldest was merged, 0 when none waits`, read_at: readAt },
    };
  } catch (err) {
    return Object.fromEntries(ids.map((id) => [id, cnc(`gh api compare failed: ${firstLine(err)}`, src)]));
  }
}

// Speed: the latest deploy that shipped merges, its slowest merge.
function lead({ deploys, readAt, source }) {
  const id = 'deploy.latest_lead_hours';
  const src = source('hours from the earliest merge the latest shipping deploy carried to that deploy going live');
  const last = deploys.findLast((d) => d.ok && d.merges?.length);
  if (!last) return { [id]: cnc(`none of the last ${deploys.length} Pages deploys has a known merge to measure`, src) };
  const each = last.merges.map((m) => ({ label: m.sha.slice(0, 7), value: hours(last.ended - m.at), unit: 'h' }));
  return { [id]: { value: Math.max(...each.map((e) => e.value)), detail: each.slice(-12), source: `${src}; the deploy of ${stamp(last.at)} (${last.sha.slice(0, 7)})`, read_at: readAt } };
}

// Quality: the latest deploy, the last 10, and the latest failure's restore.
function failures({ deploys, nowMs, readAt, source }) {
  const lastN = deploys.slice(-LAST_N);
  const latest = lastN.at(-1);
  const restoredAt = (d) => deploys.find((x) => x.ok && x.at > d.at)?.ended ?? null;
  const src = source(`a deploy failed when its newest status is failure or error; restored at the next successful deploy; the last ${lastN.length} ended deploys`);
  const fails = lastN.filter((d) => !d.ok);
  const detail = lastN.map((d) => {
    const back = d.ok ? null : restoredAt(d);
    return {
      label: stamp(d.at),
      value: d.merges?.length ?? 0,
      unit: 'merges',
      commit: d.sha.slice(0, 7),
      commit_from: 'deployment',
      lead_hours: d.merges?.length ? hours(Math.max(...d.merges.map((m) => d.ended - m.at))) : null,
      rollback: false,
      failed: d.ok ? null : 'its Pages deployment ended in failure',
      restore_hours: back ? hours(back - d.ended) : null,
    };
  });
  const out = {
    'deploy.latest_failed': { value: latest.ok ? 0 : 1, detail: [{ label: `${stamp(latest.at)} ${latest.sha.slice(0, 7)}`, value: latest.ok ? 0 : 1, unit: '' }], source: src, read_at: readAt },
    'deploy.failure_rate_last10': { value: round((fails.length / lastN.length) * 100), detail, source: src, read_at: readAt },
  };
  const lastFail = fails.at(-1);
  if (!lastFail) return { ...out, 'deploy.latest_restore_hours': cnc(`none of the last ${lastN.length} deploys failed, so there is nothing to restore`, src) };
  const back = restoredAt(lastFail);
  const h = hours((back ?? nowMs) - lastFail.ended);
  return { ...out, 'deploy.latest_restore_hours': { value: h, detail: [{ label: `${stamp(lastFail.at)} ${lastFail.sha.slice(0, 7)}${back ? '' : ', not restored yet'}`, value: h, unit: 'h' }], source: back ? src : `${src}; not restored yet, so the hours run to now`, read_at: readAt } };
}

// Consumption: the billed Actions minutes of the push to main the latest
// successful deploy shipped, every workflow run on it (deploy-lib.mjs
// pushMinutes, its gh api calls answered by the gh client).
async function buildMinutes({ gh, repo, deploys, readAt }) {
  const id = 'deploy.latest_build_minutes';
  const src = 'latest: every workflow run the push to main of the latest successful Pages deploy\'s sha started (gh api actions/runs?head_sha=&event=push, then runs/{id}/jobs), each job rounded up to the whole minute as GitHub bills it';
  const live = deploys.findLast((d) => d.ok);
  if (!live) return { [id]: cnc('no successful Pages deploy', src) };
  try {
    const viaRest = async (_cmd, [, route]) => JSON.stringify(await gh.rest(route));
    const ci = await pushMinutes(viaRest, repo, live.sha);
    if (!ci.runs.length) return { [id]: cnc(`no push run on main for ${live.sha.slice(0, 7)}`, src) };
    return { [id]: { value: ci.minutes, detail: ci.runs.map((r) => ({ label: r.name, value: r.minutes, unit: 'min' })), source: `${src}; the deploy of ${stamp(live.at)} (${live.sha.slice(0, 7)})`, read_at: readAt } };
  } catch (err) {
    return { [id]: cnc(`gh api failed: ${firstLine(err)}`, src) };
  }
}
