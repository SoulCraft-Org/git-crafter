// node --test quality/collectors/claude/claude.test.mjs
// Fixtures under quality/fixtures/claude/ are synthetic; no transcript line is copied.

import { causes, prRefs } from '../github/github.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CHARTS, loadTargets, TEXT_FIELDS } from '../../score.mjs';
import { area, classifyChecks, collect, LAST, lastN, metricIds, priceCall, projectMatch, resolvePath } from './claude.mjs';
import { redactText } from '../lib/redact.mjs';

// Only this collector's targets files, so another collector's file never fails these tests.
function ownTargets(...files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'own-targets-'));
  try {
    for (const f of files) fs.copyFileSync(new URL(`../../targets/${f}`, import.meta.url), path.join(dir, f));
    return loadTargets(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}


const fixtures = new URL('../../fixtures/claude/', import.meta.url);
const projectsDir = fileURLToPath(new URL('projects/', fixtures));
const readJson = (name) => JSON.parse(fs.readFileSync(new URL(name, fixtures), 'utf8'));
const prs = readJson('gh/prs.json');
const commits = readJson('gh/commits.json');
const reverts = readJson('gh/reverts.json');
const issues = readJson('gh/issues.json');
const targets = JSON.parse(fs.readFileSync(new URL('../../targets/claude.json', import.meta.url), 'utf8'));
const now = new Date('2026-11-02T12:00:00Z');
const TOKENS_TAB = new Set([
  'claude.tokens_per_merged_pr',
  'claude.cache_read_share',
  'claude.context_per_call',
  'claude.compactions_per_10_prs',
  'claude.subagent_cost_share',
]);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-collector-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
// The template's params plus the fixture repo's project match, as a repo's
// quality/targets/claude.json override would give them.
const params = { ...Object.assign({}, ...targets.map((t) => t.params ?? {})), project_match: 'acme-site' };
const base = {
  root: path.join(tmp, 'repo'),
  mode: 'local',
  projectsDir,
  now,
  home: path.join(tmp, 'home'),
  params,
};

// Answers the four gh calls the collector makes, from the fixtures. A batched
// pullRequest query answers like GitHub: a PR not in prMap is null with a
// NOT_FOUND error, a PR in prErrors is null with that error, repoError hides
// the whole repository, and gh then exits 1 with the whole response still on
// stdout (checked 2026-11-03).
function fakeGh(calls = [], { prMap = prs, prErrors = {}, revertMap = reverts, repoError } = {}) {
  return async (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'api' && args[1] === 'graphql') {
      const query = args[3];
      const [, owner, name] = /repository\(owner: "([^"]+)", name: "([^"]+)"\)/.exec(query);
      const repository = {};
      const errors = [];
      for (const [, alias, sha] of query.matchAll(/(c\d+): object\(oid: "(\w+)"\)/g)) {
        repository[alias] = { statusCheckRollup: { contexts: { nodes: commits[sha] ?? [] } } };
      }
      for (const [, alias, n] of query.matchAll(/(p(\d+)): pullRequest\(number: \d+\)/g)) {
        const key = `${owner}/${name}#${n}`;
        const err = prErrors[key] ?? (prMap[key] ? null : { type: 'NOT_FOUND', message: `Could not resolve to a PullRequest with the number of ${n}.` });
        repository[alias] = err ? null : prMap[key];
        if (err) errors.push({ ...err, path: ['repository', alias] });
      }
      // repoError answers like a private repo the gh login cannot see: no repository, one error above every PR.
      if (repoError && /pullRequest\(number:/.test(query)) {
        const denied = JSON.stringify({ data: { repository: null }, errors: [{ ...repoError, path: ['repository'] }] });
        throw Object.assign(new Error('Command failed: gh api graphql'), { stdout: denied, stderr: `gh: ${repoError.message}` });
      }
      const body = JSON.stringify({ data: { repository }, ...(errors.length ? { errors } : {}) });
      if (errors.length) throw Object.assign(new Error('Command failed: gh api graphql'), { stdout: body, stderr: `gh: ${errors[0].message}` });
      return body;
    }
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(revertMap[args[3]] ?? []);
    // Bugs are read by the Bug issue type; a bug label read is a regression.
    if (args[0] === 'issue' && args[1] === 'list') return args.join(' ').includes('--type Bug') && !args.includes('--label') ? JSON.stringify(issues[args[3]] ?? []) : 'unexpected bug read: ' + args.join(' ');
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
}

const value = (r, id) => {
  assert.ok(!r[id].could_not_check, `${id}: ${r[id].could_not_check}`);
  return r[id].value;
};
const detail = (r, id) => Object.fromEntries(r[id].detail.map((d) => [d.label, d.value]));

test('exports the area and one result per target', async () => {
  assert.equal(area, 'claude');
  const r = await collect({ ...base, gh: fakeGh() });
  assert.deepEqual(Object.keys(r), metricIds);
});

test('known-good fixture returns the hand-computed values', async () => {
  const calls = [];
  const r = await collect({ ...base, gh: fakeGh(calls) });

  // No calendar window: every metric reads the last N events up to now
  // (1,000 calls, 20 PRs, 5 costed sessions), which the fixture never fills,
  // so each reads all of its events. Other-Project is ignored throughout.

  // Tokens over the five calls: each message.id counts once, at its largest usage.
  // input 120, output 2000, cache write 12000, cache read 119000.
  assert.equal(value(r, 'claude.cache_read_share'), 90.8);
  assert.deepEqual(detail(r, 'claude.cache_read_share'), { 'cache read': 119000, 'cache write': 12000, 'fresh input': 120 });
  // Rows from 2026-10-21 on (no version in the fixture), main and subagent alike: the 10-10 and 10-20 calls are left out.
  // The subagent runs on Haiku 5.5, a fortieth of Opus 5.5's price: its cost share is far under its 21.7% token share.
  // Opus 5.5's cache reads at 0.05x make the main sessions cheaper than at the old flat 0.1x (0.9).
  assert.equal(value(r, 'claude.subagent_cost_share'), 1.1);

  // Per merged PR: #1, #2 and #6. Session one's 2317 billable tokens split over
  // its two merged PRs, session three's 11100 to #6: (1158.5 x 2 + 11100) / 3.
  assert.equal(value(r, 'claude.tokens_per_merged_pr'), 4472);
  assert.deepEqual(detail(r, 'claude.tokens_per_merged_pr'), { 'cache write': 3900, output: 533, 'fresh input': 39 });

  // Context per call: 1303, 3202 (subagent), 6010, 20505, 100100.
  assert.equal(value(r, 'claude.context_per_call'), 6010);
  assert.deepEqual(detail(r, 'claude.context_per_call'), {
    'main sessions, median': 13258,
    'subagents, median': 3202,
    'p90, all calls': 68262,
    'all time, median': 6010,
  });

  // Lines and cost over the last 5 costed sessions, one and three: 200 + 600 lines in 2 h + 3 h.
  // Cost: $12 split over #1 and #2, $30 to #6: (6 + 6 + 30) / 3.
  assert.equal(value(r, 'claude.cost_per_merged_pr_usd'), 14);

  // Merge share: the last opened PRs that finished, #1, #2, #6 merged and #3, #11 closed.
  // #10 reverted #6 and #7 reverted #2 by now; #8, reverting #1, merges after now.
  assert.equal(value(r, 'claude.pr_merge_share'), 60);
  assert.deepEqual(detail(r, 'claude.pr_merge_share'), { 'merged or closed': 5, merged: 3, 'not reverted so far': 1 });
  // Opened: #1, #2, #3, #6, #11. #4 opened before its session and #5 is a bot's.
  assert.equal(value(r, 'claude.first_push_green_share'), 66.7);
  assert.deepEqual(detail(r, 'claude.first_push_green_share'), {
    green: 2,
    red: 1,
    pending: 0,
    'cancelled, no verdict': 0,
    'no checks': 2,
    'failed: site-tests': 1,
  });

  // Bugs filed after a merge that name it as the cause, up to now: #20 and #22 (Regressed-by: #2),
  // #22 also #1 (caused by acme/site#1), #23 (introduced in PR #6) and #25 (Regressed-by: #6).
  // #21 named #1 before it merged, #24 names no Claude PR, #26 mentions #2 and #6 only as
  // context, and #27 blames another repository's PR 2 (other/repo#2). 4 issues over 3 PRs.
  assert.equal(value(r, 'claude.escaped_bugs_per_10_prs'), 13.33);
  assert.deepEqual(detail(r, 'claude.escaped_bugs_per_10_prs'), {
    'bug issues naming a merged PR as the cause': 4,
    'merged Claude PRs': 3,
    '#6': 2,
    '#2': 2,
    '#1': 1,
    'all time, per 10 merged PRs': 13.33,
  });

  // Tests: only #1 changes a test.
  assert.equal(value(r, 'claude.code_prs_with_tests_share'), 33.3);

  // Delivery: opened 0.92, 3, 2, 0.83 and 1.5 h after their sessions began.
  assert.equal(value(r, 'claude.hours_session_to_pr'), 1.5);

  // Compactions: session one's one split over #1 and #2, session three's to #6: 2 per 3 PRs.
  assert.equal(value(r, 'claude.compactions_per_10_prs'), 6.67);
  assert.equal(detail(r, 'claude.compactions_per_10_prs')['compactions, these PRs'], 2);

  // Every value carries its source and read time, and names its N or says it is a state.
  for (const [id, v] of Object.entries(r)) {
    assert.ok(v.source, id);
    assert.equal(v.read_at, now.toISOString());
    assert.match(v.source, new RegExp(`the last (${LAST.calls}|${LAST.prs}|${LAST.sessions}|${LAST.consumption}) `), id);
    assert.doesNotMatch(v.source, /trailing|days ago|\b(7|14|28) days\b/, id);
  }
  assert.ok(!calls.some((c) => c.includes('acme/other')), "never asks about another project's PRs");
});


test('lastN keeps the latest n at or before now, oldest first', () => {
  const at = (x) => x.at;
  const list = [{ at: 5 }, { at: 1 }, { at: 9 }, { at: 3 }, { at: NaN }];
  assert.deepEqual(lastN(list, 2, at, 8).map(at), [3, 5]);
  assert.deepEqual(lastN(list, 10, at, 8).map(at), [1, 3, 5]);
  assert.deepEqual(lastN(list, 2, at, 0), []);
});

test('the last 2 model calls: older calls drop out of every per-call metric', async () => {
  const r = await collect({ ...base, gh: fakeGh(), last: { ...LAST, calls: 2 } });
  // The latest two: the subagent's 10:15 call and session one's 10:30 call.
  assert.equal(value(r, 'claude.cache_read_share'), 97);
  assert.deepEqual(detail(r, 'claude.cache_read_share'), { 'cache read': 23000, 'cache write': 700, 'fresh input': 7 });
  assert.equal(value(r, 'claude.context_per_call'), 11854);
  assert.match(r['claude.cache_read_share'].source, /the last 2 model calls/);
  // Per-PR metrics read the PRs' sessions, not the call cut-off.
  assert.equal(value(r, 'claude.tokens_per_merged_pr'), 4472);
});

test('the last merged PR: only the latest counts, and reverts are its state now', async () => {
  const one = { ...LAST, prs: 1, consumption: 1 };
  const r = await collect({ ...base, gh: fakeGh(), last: one });
  // #2 merged last (2026-10-30 16:00) and opened last (13:00, 3 h into session one).
  assert.equal(value(r, 'claude.hours_session_to_pr'), 3);
  // Session one's 2317 tokens split over its two merged PRs.
  assert.equal(value(r, 'claude.tokens_per_merged_pr'), 1159);
  assert.equal(value(r, 'claude.cost_per_merged_pr_usd'), 6);
  assert.deepEqual(detail(r, 'claude.pr_merge_share'), { 'merged or closed': 1, merged: 1, 'not reverted so far': 0 });
  // #7 reverted #2 on 2026-11-01, so it counts from then on, and not before.
  const before = await collect({ ...base, gh: fakeGh(), last: one, now: new Date('2026-10-31T12:00:00Z') });
  assert.deepEqual(detail(before, 'claude.pr_merge_share'), { 'merged or closed': 1, merged: 1, 'not reverted so far': 1 });
  // #20 (10-31 09:00) is the one bug on #2 by then.
  assert.equal(value(before, 'claude.escaped_bugs_per_10_prs'), 10);
});



test('funnels shrink, stacks have at most 5 parts, and every breakdown row names its unit', async () => {
  const r = await collect({ ...base, gh: fakeGh() });
  for (const t of targets) {
    const v = r[t.id];
    for (const row of v.detail ?? []) assert.ok(typeof row.unit === 'string' && row.unit, `${t.id} "${row.label}" has no unit`);
    if (t.chart === 'funnel') {
      const values = v.detail.map((d) => d.value);
      assert.ok(values.every((n, i) => i === 0 || n <= values[i - 1]), `${t.id} stages grow: ${values}`);
    }
    if (t.chart === 'stack') {
      assert.ok(v.detail.length >= 2 && v.detail.length <= 5, `${t.id} has ${v.detail.length} parts`);
      assert.equal(new Set(v.detail.map((d) => d.unit)).size, 1, `${t.id} parts share one unit`);
      assert.ok(v.detail.every((d) => d.value >= 0), `${t.id} has a negative part`);
    }
    // Bars are drawn against the largest row, so they must share one unit too.
    if (t.chart === 'bar') assert.equal(new Set(v.detail.map((d) => d.unit)).size, 1, `${t.id} bars mix units`);
  }
});

test('output holds aggregates only: no text, titles, commit messages or session ids', async () => {
  const out = JSON.stringify(await collect({ ...base, gh: fakeGh() }));
  for (const banned of ['DECOY', 'session-fixture', 'msg-fixture', 'req-fixture', 'Add widget', 'Fix footer', 'Footer overlaps', 'preTokens']) {
    assert.ok(!out.includes(banned), `output contains ${banned}`);
  }
});

const assertAllCouldNotCheck = (r, pattern) => {
  assert.deepEqual(Object.keys(r), metricIds);
  for (const [id, v] of Object.entries(r)) {
    assert.match(v.could_not_check, pattern, id);
    assert.ok(!('value' in v), `${id} must not carry a value`);
    assert.ok(v.source, id);
  }
};

test('ci mode never reads transcripts', async () => {
  const r = await collect({ ...base, mode: 'ci', gh: fakeGh() });
  assertAllCouldNotCheck(r, /^transcripts live on the machine that ran the sessions; refreshed by a --local collect there$/);
});

test('a missing projects folder is could_not_check, not a throw and not 0', async () => {
  const r = await collect({ ...base, projectsDir: '/nonexistent/claude/projects', gh: fakeGh() });
  assertAllCouldNotCheck(r, /could not read transcripts/);
});

test('a projects folder with no sessions of this repo is could_not_check', async () => {
  const empty = fileURLToPath(new URL('projects/-Users-someone-Developer-Other-Project/', fixtures));
  const r = await collect({ ...base, projectsDir: empty, gh: fakeGh() });
  assertAllCouldNotCheck(r, /no transcripts match/);
});

test('without gh, PR metrics are could_not_check and token metrics still read', async () => {
  const noGh = async () => {
    throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
  };
  const r = await collect({ ...base, gh: noGh });
  for (const id of [
    'claude.pr_merge_share',
    'claude.tokens_per_merged_pr',
    'claude.cost_per_merged_pr_usd',
    'claude.escaped_bugs_per_10_prs',
    'claude.compactions_per_10_prs',
  ]) {
    assert.match(r[id].could_not_check, /^gh could not read 7 of 7 linked PRs \(spawn gh ENOENT\)$/, id);
  }
  assert.equal(value(r, 'claude.cache_read_share'), 90.8);
  assert.equal(value(r, 'claude.context_per_call'), 6010);
});

test('a bug blames a PR only as its cause, the way the Blockers tab reads it', () => {
  // The site's own cases (code-os#156): #767's cause line counts; #762 and #768 only mention a PR.
  assert.deepEqual([...causes('The page breaks.\nRegressed-by: #759')], [759]);
  assert.deepEqual([...causes('A late find, introduced in PR #12.')], [12]);
  assert.deepEqual([...causes("Seen in #739's merge ref.")], []);
  assert.deepEqual([...causes("Found by reviewer B in #718's round 3.")], []);
  // code-os#158: a full URL, a list item, several PRs on one line; a quote is someone else's claim.
  const site = 'acme/site';
  const read = (text) => [...causes(text, site)];
  assert.deepEqual(read('Regressed-by: #5'), [5]);
  assert.deepEqual(read('Regressed-by: https://github.com/acme/site/pull/5'), [5]);
  assert.deepEqual(read('The page breaks, caused by https://github.com/acme/site/pull/5.'), [5]);
  assert.deepEqual(read('Steps:\n- Regressed-by: #5'), [5]);
  assert.deepEqual(read('* Regressed-by: #5'), [5]);
  assert.deepEqual(read('Regressed-by: #5, #6'), [5, 6]);
  assert.deepEqual(read('Regressed-by: #5 and https://github.com/acme/site/pull/6'), [5, 6]);
  assert.deepEqual(read('> Regressed-by: #5'), [], 'a quoted line is no claim of this bug');
  assert.deepEqual(read('> The release notes say this was caused by #5.'), []);
  // Another repository's PR 5 is not this repository's PR 5; this one's, in any case, is.
  assert.deepEqual(read('Regressed-by: other/repo#5'), []);
  assert.deepEqual(read('caused by https://github.com/other/repo/pull/5'), []);
  assert.deepEqual(read('Regressed-by: Acme/Site#5, other/repo#6'), [5]);
  assert.deepEqual([...prRefs('Reverts other/repo#3 and #4', site)], [4]);
  assert.deepEqual([...prRefs('Reverts other/repo#3 and #4')], [3, 4], 'with no repository, every reference counts');
  // The fixture's #27 blames PR 2 with no repository check, and none with one.
  const other = issues['acme/site'].find((i) => i.number === 27).body;
  assert.deepEqual([...causes(other)], [2]);
  assert.deepEqual([...causes(other, site)], [], "another repository's PR 2");
});

test('causes() reads a long line in linear time', () => {
  for (const text of ['Regressed-by: #1' + ' '.repeat(65_000) + 'x', 'Regressed-by:' + ' '.repeat(65_000) + 'x', 'caused by' + ' '.repeat(65_000) + 'x']) {
    const start = performance.now();
    causes(text, 'acme/site');
    assert.ok(performance.now() - start < 50, `${text.slice(0, 16)}… took ${Math.round(performance.now() - start)} ms`);
  }
});

test('a failed first-push or bug query only blanks its own metric', async () => {
  // failOn matches the start of a gh call; the commit-checks query is the GraphQL one that reads object(oid:).
  const gh = (failOn) => {
    const ok = fakeGh();
    return async (args) => {
      if (failOn(args)) throw new Error('HTTP 502');
      return ok(args);
    };
  };
  const push = await collect({ ...base, gh: gh((args) => args[1] === 'graphql' && args[3].includes('object(oid:')) });
  assert.match(push['claude.first_push_green_share'].could_not_check, /gh api graphql failed \(HTTP 502\)/);
  assert.equal(value(push, 'claude.pr_merge_share'), 60);

  const bugs = await collect({ ...base, gh: gh((args) => args[0] === 'issue' && args[1] === 'list') });
  assert.match(bugs['claude.escaped_bugs_per_10_prs'].could_not_check, /gh issue list failed for acme\/site \(HTTP 502\)/);
  assert.equal(value(bugs, 'claude.code_prs_with_tests_share'), 33.3);
});

test('a linked PR GitHub does not have is skipped and counted in a detail row', async () => {
  const { 'acme/site#3': _gone, ...prMap } = prs;
  const r = await collect({ ...base, gh: fakeGh([], { prMap }) });
  assert.equal(detail(r, 'claude.hours_session_to_pr')['linked PRs GitHub does not have'], 1);
  assert.equal(detail(r, 'claude.hours_session_to_pr')['PRs opened'], 4);
});

test('a repository GitHub will not show fails its PRs, never marks them missing', async () => {
  // A private repo the gh login cannot see answers NOT_FOUND on the repository itself, above every PR.
  const repoError = { type: 'NOT_FOUND', message: "Could not resolve to a Repository with the name 'acme/site'." };
  const r = await collect({ ...base, gh: fakeGh([], { repoError }) });
  for (const id of [
    'claude.pr_merge_share',
    'claude.first_push_green_share',
    'claude.hours_session_to_pr',
  ]) {
    assert.equal(r[id].could_not_check, "gh could not read 7 of 7 linked PRs (Could not resolve to a Repository with the name 'acme/site'.)", id);
  }
});

test('any other gh error on one linked PR blanks every PR metric, never a partial count', async () => {
  const prErrors = { 'acme/site#5': { type: 'FORBIDDEN', message: 'Resource not accessible by integration' } };
  const r = await collect({ ...base, gh: fakeGh([], { prErrors }) });
  const prIds = [
    'claude.pr_merge_share',
    'claude.first_push_green_share',
    'claude.escaped_bugs_per_10_prs',
    'claude.tokens_per_merged_pr',
  ];
  for (const id of prIds) {
    assert.equal(r[id].could_not_check, 'gh could not read 1 of 7 linked PRs (Resource not accessible by integration)', id);
    assert.ok(!('value' in r[id]), id);
  }
  assert.equal(value(r, 'claude.cache_read_share'), 90.8);
});

test("a failed revert query blanks the funnel's last stage only", async () => {
  const ok = fakeGh();
  const gh = async (args) => {
    if (args[0] === 'pr' && args[1] === 'list') throw Object.assign(new Error('Command failed'), { stderr: 'HTTP 502: Bad Gateway' });
    return ok(args);
  };
  const r = await collect({ ...base, gh });
  assert.deepEqual(detail(r, 'claude.pr_merge_share'), { 'merged or closed': 5, merged: 3 });
  assert.equal(value(r, 'claude.escaped_bugs_per_10_prs'), 13.33);
});

test('before any event, a metric is could_not_check, never 0', async () => {
  // 2026-10-01 is before every fixture line, PR and session.
  const r = await collect({ ...base, gh: fakeGh(), now: new Date('2026-10-01T12:00:00Z') });
  // One id a line: on one line, gitleaks' generic-api-key rule reads this list as a token assignment.
  const ids = [
    'claude.pr_merge_share',
    'claude.code_prs_with_tests_share',
    'claude.tokens_per_merged_pr',
    'claude.escaped_bugs_per_10_prs',
    'claude.compactions_per_10_prs',
    'claude.hours_session_to_pr',
  ];
  for (const id of ids) {
    assert.ok(r[id].could_not_check, id);
    assert.ok(!('value' in r[id]), id);
  }
  assert.equal(r['claude.cache_read_share'].could_not_check, 'no assistant usage in the transcripts');
});


test('targets file matches the contract', () => {
  assert.deepEqual(ownTargets('claude.json').map((d) => d.id), metricIds, 'the engine loads every definition');
  const ids = targets.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  for (const t of targets) {
    assert.match(t.id, /^claude\.[a-z0-9_]+$/);
    // The token metrics sit on the Tokens tab by their tab field alone.
    assert.equal(t.tab, TOKENS_TAB.has(t.id) ? 'tokens' : 'claude', t.id);
    assert.ok(['quality', 'speed', 'consumption'].includes(t.kind), t.id);
    assert.ok(t.label.split(/\s+/).length <= 6, `${t.id} label has more than 6 words`);
    assert.ok(typeof t.unit === 'string' && t.unit, t.id);
    assert.equal(typeof t.goal, 'number', t.id);
    assert.equal(typeof t.near, 'number', t.id);
    assert.ok(['higher', 'lower'].includes(t.direction), t.id);
    // The near band sits on the missing side of the goal.
    assert.ok(t.direction === 'higher' ? t.near <= t.goal : t.near >= t.goal, `${t.id} near is on the wrong side`);
    // Every goal names the public source it comes from, or says it is a template default.
    assert.match(t.goal_source, /^(goal from |template goal, no public benchmark: )/, t.id);
    assert.ok(t.source, t.id);
    assert.equal(t.needs, 'local-files');
    assert.ok(CHARTS.has(t.chart), t.id);
    // Plain words for a non-engineer: no figures, within the contract's length.
    assert.ok(typeof t.means === 'string' && t.means.length <= TEXT_FIELDS.means, `${t.id} means`);
    assert.doesNotMatch(t.means, /\d/, `${t.id} means holds a figure`);
    assert.ok(typeof t.group === 'string' && t.group.length <= TEXT_FIELDS.group, `${t.id} group`);
  }
  assert.deepEqual([...new Set(targets.map((t) => `${t.kind}: ${t.group}`))], [
    'quality: Holds up',
    'quality: Tests',
    'speed: Delivery',
    'consumption: Use',
    'speed: Tokens',
  ]);
});


test('priceCall: one row per pricing case, at the pricing page in params', () => {
  const row = (model, extra) => ({ model, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...extra });
  const M = 1e6;
  // Sonnet 5.5 at $2 in, $10 out.
  assert.equal(priceCall(row('claude-sonnet-5-5', { input: M, output: M })), 12);
  // Haiku 5.5 under 100K prompt tokens: $0.10 in, $0.50 out.
  assert.equal(priceCall(row('claude-haiku-5-5', { input: 50_000, output: M })), 0.505);
  // Haiku 5.5 over 100K prompt tokens (input plus cache): the long tier, $0.50 in, $2.50 out.
  assert.equal(priceCall(row('claude-haiku-5-5', { input: 10_000, cacheRead: 200_000, output: M })), 0.005 + 0.01 + 2.5);
  // Opus 5.5, $4 in: a 5-minute write is 1.25x input, a 1-hour write 2x, a read 0.1x.
  assert.equal(priceCall(row('claude-opus-5-5', { cacheWrite: 2 * M, cacheWrite5m: M, cacheWrite1h: M })), 5 + 8);
  assert.equal(priceCall(row('claude-opus-5-5', { cacheWrite: M })), 5, 'a write the usage does not split is 5-minute');
  // Opus 5.5 and Sonnet 5.5 read cache at their own 0.05x; Haiku 5.5 at the default 0.1x.
  assert.equal(priceCall(row('claude-opus-5-5', { cacheRead: M })), 0.2);
  assert.equal(priceCall(row('claude-sonnet-5-5', { cacheRead: M })), 0.1);
  assert.ok(Math.abs(priceCall(row('claude-haiku-5-5', { cacheRead: 100_000 })) - 0.001) < 1e-12);
  // Params with no per-model read multiplier keep the default, so older callers price as before.
  assert.equal(priceCall(row('claude-opus-5-5', { cacheRead: M }), { prices: { 'claude-opus-5-5': { input: 4, output: 20 } }, cache_read_x: 0.1, cache_write_5m_x: 1.25, cache_write_1h_x: 2 }), 0.4);
  assert.equal(priceCall(row('claude-unknown-1', { input: M })), null, 'no price: left out, never 0');
});

test('the subagent cost share has no priced call when every call predates 2.1.307', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-version-'));
  const folder = path.join(dir, '-Users-someone-Developer-acme-site');
  fs.mkdirSync(folder, { recursive: true });
  // Dated after 2026-10-21 but from 2.1.299: the version decides.
  const line = (id, side) => JSON.stringify({ type: 'assistant', timestamp: '2026-10-28T10:00:00Z', sessionId: 'v1', isSidechain: side, version: '2.1.299', message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 10 } } });
  fs.writeFileSync(path.join(folder, 'v1.jsonl'), `${line('a', false)}\n${line('b', true)}\n`);
  try {
    const r = await collect({ ...base, projectsDir: dir, gh: async () => { throw new Error('no gh'); } });
    assert.match(r['claude.subagent_cost_share'].could_not_check, /no priced model call/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyChecks: a cancelled check is no verdict, and a check that reads the PR is left out', () => {
  const run = (name, conclusion) => ({ __typename: 'CheckRun', name, conclusion });
  const notCode = new Set(['claude-review']);
  assert.deepEqual(classifyChecks([run('build', 'SUCCESS'), run('deploy', 'CANCELLED')], notCode), { state: 'cancelled', failed: [] });
  assert.deepEqual(classifyChecks([run('build', 'SUCCESS'), run('claude-review', 'FAILURE')], notCode), { state: 'green', failed: [] });
  assert.deepEqual(classifyChecks([run('claude-review', 'FAILURE')], notCode), { state: 'none', failed: [] });
  assert.deepEqual(classifyChecks([run('build', 'FAILURE'), run('e2e', 'CANCELLED')], notCode), { state: 'red', failed: ['build'] });
  assert.deepEqual(classifyChecks([{ __typename: 'StatusContext', context: 'DCO', state: 'ACTION_REQUIRED' }], notCode), { state: 'red', failed: ['DCO'] });
});

test('projectMatch: the main checkout as Claude Code names its folder, so worktrees match too', () => {
  assert.equal(projectMatch('/Users/someone/Developer/acme site'), '-Users-someone-Developer-acme-site');
  assert.equal(projectMatch('/Users/someone/Developer/acme site/.claude/worktrees/fix-1'), '-Users-someone-Developer-acme-site');
});

test('with no params passed, the template applies and the repo path names its project folder', async () => {
  // The fixture folders are this checkout's, as Claude Code names them.
  const r = await collect({ ...base, root: '/Users/someone/Developer/acme site', params: undefined, gh: fakeGh() });
  assert.equal(value(r, 'claude.cache_read_share'), 90.8);
  // The template's prices apply, and it lists no check that reads the PR, so site-tests' red counts.
  assert.equal(value(r, 'claude.subagent_cost_share'), 1.1);
  assert.equal(value(r, 'claude.first_push_green_share'), 66.7);
});

test('an empty folder name never matches every project folder', async () => {
  // With no match set, a root of / falls back to "-", which is in every folder name.
  const r = await collect({ ...base, root: '/', params: { ...params, project_match: '' }, gh: fakeGh() });
  assertAllCouldNotCheck(r, /would read every project folder/);
});

test('the collector holds no repo or account value: each comes from params or the repo path', () => {
  const code = fs.readFileSync(new URL('./claude.mjs', import.meta.url), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  for (const word of ['/Users/', 'Developer/', 'acme']) assert.ok(!code.includes(word), `${word} in the code`);
});

test('the transcript folder is params.projects_dir, and the source names it', async () => {
  const r = await collect({ ...base, projectsDir: undefined, params: { ...params, projects_dir: projectsDir }, gh: fakeGh() });
  assert.equal(value(r, 'claude.cache_read_share'), 90.8);
  // The collector redacts its output, so the source shows the folder as redactText leaves it: ~ for a /Users/<name> home, the path itself on a CI runner.
  const shown = redactText(projectsDir, base.home);
  assert.ok(r['claude.cache_read_share'].source.startsWith(`${shown}/*acme-site*/`), r['claude.cache_read_share'].source);
  assert.equal(resolvePath('~/x/y', { home: '/h', root: '/r' }), '/h/x/y');
  assert.equal(resolvePath('/abs/y', { home: '/h', root: '/r' }), '/abs/y');
  assert.equal(resolvePath('rel/y', { home: '/h', root: '/r' }), '/r/rel/y');
});
