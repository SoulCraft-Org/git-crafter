// The deploy collector's pure parts: parsing Wrangler and git output, matching
// deploys to commits, and judging failures. deploy.mjs re-exports them.

// The median of a list of numbers, or null when it is empty.
export function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Wrangler prints JSON; anything before the first bracket is a notice.
export function parseJsonList(text) {
  const start = String(text).search(/[[{]/);
  const list = JSON.parse(String(text).slice(start));
  if (!Array.isArray(list)) throw new Error('expected a JSON array');
  return list;
}

// First-parent history, newest first: { sha, at (ms), subject, pr }.
export function parseLog(text) {
  return String(text)
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, at, ...rest] = line.split('\t');
      const subject = rest.join('\t');
      const pr = /Merge pull request #(\d+)/.exec(subject);
      return { sha, at: Date.parse(at), subject, pr: pr ? Number(pr[1]) : null };
    })
    .filter((c) => c.sha && Number.isFinite(c.at));
}

// The production deploys in time order, each with its version number, the
// commit it shipped and how that commit is known. A deploy that only set a
// secret ships no code and is kept apart.
export function resolveDeploys(deployments, versions, history) {
  const byVersion = new Map(versions.map((v) => [v.id, v]));
  let highest = -Infinity;
  return [...deployments]
    .map((d) => ({ d, at: Date.parse(d.created_on) }))
    .filter((x) => Number.isFinite(x.at))
    .sort((a, b) => a.at - b.at)
    .map(({ d, at }) => {
      const version = mainVersion(d, byVersion);
      const notes = { ...(version.annotations ?? {}), ...(d.annotations ?? {}) };
      const trigger = d.annotations?.['workers/triggered_by'] ?? '';
      const number = Number.isFinite(version.number) ? version.number : null;
      const rollback = isRollback(trigger, number, highest);
      highest = Math.max(highest, number ?? -Infinity);
      const { index, from } = commitOf(d, version, notes, history);
      const found = index >= 0;
      return {
        id: d.id,
        at,
        number,
        trigger,
        secret: trigger === 'secret',
        rollback,
        index: found ? index : null,
        commit: found ? history[index].sha.slice(0, 7) : null,
        from,
        message: notes['workers/message'] ?? '',
      };
    });
}

const isRollback = (trigger, number, highest) => trigger === 'rollback' || (number !== null && number < highest);

// The version that took the most traffic in a deploy.
function mainVersion(d, byVersion) {
  const main = [...(d.versions ?? [])].sort((a, b) => (b.percentage ?? 0) - (a.percentage ?? 0))[0];
  return byVersion.get(main?.version_id) ?? {};
}

// The commit a deploy shipped: the version's tag, a sha in its message, else
// main when the version was uploaded. { index into history, how it is known }.
function commitOf(d, version, notes, history) {
  const named = /main-([0-9a-f]{7,40})\b/.exec(notes['workers/tag'] ?? '')?.[1] ?? /\b([0-9a-f]{7,40})\b/.exec(notes['workers/message'] ?? '')?.[1];
  const tagged = named ? history.findIndex((c) => c.sha.startsWith(named)) : -1;
  if (tagged >= 0) return { index: tagged, from: 'tag' };
  const uploaded = Date.parse(version.metadata?.created_on ?? d.created_on);
  const index = history.findIndex((c) => c.at <= uploaded);
  return { index, from: index < 0 ? 'unknown' : 'time' };
}

// When each merge went live: the first code deploy after it whose commit
// contains it (history is newest first, so a smaller index is newer).
export function liveTimes(merges, deploys, history) {
  const index = new Map(history.map((c, i) => [c.sha, i]));
  const code = deploys.filter((d) => !d.secret && !d.rollback && d.index !== null);
  return merges.map((m) => {
    const i = index.get(m.sha);
    const live = i === undefined ? null : code.find((d) => d.at >= m.at && d.index <= i);
    return { ...m, live_at: live ? live.at : null, deploy: live ? live.id : null };
  });
}

// Failed deploys and when each was restored. issues: [{ number, body,
// closedAt }] whose body names the PR that caused them.
export function failures(deploys, merges, issues) {
  const code = deploys.filter((d) => !d.secret);
  const out = new Map();
  code.forEach((d, i) => {
    const next = code[i + 1];
    if (next?.rollback && !d.rollback) out.set(d.id, { deploy: d, why: 'rolled back', restored: next.at });
  });
  const byPr = new Map(merges.filter((m) => m.pr !== null).map((m) => [m.pr, m]));
  for (const issue of issues) {
    for (const [, n] of String(issue.body ?? '').matchAll(/Regressed-by:\s*#(\d+)/gi)) {
      const m = byPr.get(Number(n));
      const d = m?.deploy && code.find((x) => x.id === m.deploy);
      if (!d || out.has(d.id)) continue;
      const closed = Date.parse(issue.closedAt ?? '');
      const fix = Number.isFinite(closed) ? code.find((x) => x.at >= closed && !x.rollback) : null;
      out.set(d.id, { deploy: d, why: `issue #${issue.number} names PR #${n}`, restored: fix ? fix.at : null });
    }
  }
  return [...out.values()].sort((a, b) => a.deploy.at - b.deploy.at);
}

// GitHub bills each job rounded up to the whole minute (docs.github.com,
// "About billing for GitHub Actions"). Sums every job of every workflow run
// that the push to main of one commit started. Returns { minutes, runs:
// [{ name, minutes }] } or throws.
export async function pushMinutes(exec, repo, sha, cwd) {
  const list = JSON.parse(await exec('gh', ['api', `repos/${repo}/actions/runs?head_sha=${sha}&event=push&per_page=50`], { cwd }));
  const runs = [];
  for (const run of list.workflow_runs ?? []) {
    const jobs = JSON.parse(await exec('gh', ['api', `repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`], { cwd }));
    let minutes = 0;
    for (const job of jobs.jobs ?? []) {
      const ms = Date.parse(job.completed_at ?? '') - Date.parse(job.started_at ?? '');
      if (Number.isFinite(ms) && ms > 0) minutes += Math.ceil(ms / 60_000);
    }
    runs.push({ name: run.name, minutes });
  }
  return { minutes: runs.reduce((n, r) => n + r.minutes, 0), runs };
}
