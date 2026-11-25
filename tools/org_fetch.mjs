// The impure reads: the gh client and the GraphQL and REST queries behind
// every metric.

import { execFileSync } from "node:child_process";

import { ORG } from "./org_base.mjs";
import { isServerError, runMany, runManySettled } from "./org_many.mjs";
import { WORKERS_APP } from "./org_signals.mjs";

export { isServerError };

// ---- Fetching (impure) ------------------------------------------------------

// A 5xx is a passing GitHub error, so a read retries it once after RETRY_MS.
// A 4xx or a rate limit is GitHub's answer and is never retried. A second
// failure reaches the caller, and its metric reads could_not_check.
export const RETRY_MS = 5000;
// True for GitHub's primary or secondary rate limit: an answer about its own budget, never about a repo's content.
export const isRateLimit = (err) => /rate limit/i.test(String(err?.stderr || err?.message || err));
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// A gh wrapper that counts calls and retries a server error once. restMany reads a list of REST paths side by
// side (org_many.mjs) when it runs the real gh; a stand-in exec, as in the tests, reads them one by one.
const graphqlArgs = (query, vars) => ["api", "graphql", "-f", `query=${query}`, ...Object.entries(vars).filter(([, v]) => v !== null && v !== undefined).flatMap(([k, v]) => ["-f", `${k}=${v}`])];
// The gh arguments of one read: { graphql: [query, vars] } or { rest: path, jq }.
const unitArgs = (u) => (u.graphql ? graphqlArgs(...u.graphql) : ["api", u.rest, ...(u.jq ? ["--jq", u.jq] : [])]);
const unitValue = (u, text) => (u.graphql ? JSON.parse(text).data : JSON.parse(text));

export function ghClient(exec = execFileSync, wait = sleep) {
  let calls = 0;
  let graphqlCalls = 0;
  const once = (args) => {
    calls += 1;
    if (args[1] === "graphql") graphqlCalls += 1;
    return exec("gh", args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
  };
  const run = (args) => {
    try {
      return once(args);
    } catch (err) {
      if (!isServerError(err)) throw err;
      wait(RETRY_MS);
      return once(args);
    }
  };
  return {
    get calls() {
      return calls;
    },
    get graphqlCalls() {
      return graphqlCalls;
    },
    rest: (path, jq) => JSON.parse(run(["api", path, ...(jq ? ["--jq", jq] : [])])),
    restMany: (paths, jq) => {
      const argsList = paths.map((path) => ["api", path, ...(jq ? ["--jq", jq] : [])]);
      if (exec !== execFileSync) return argsList.map((args) => JSON.parse(run(args)));
      calls += argsList.length;
      return runMany("gh", argsList, { retryMs: RETRY_MS }).map((out) => JSON.parse(out));
    },
    restLines: (path, jq) =>
      run(["api", "--paginate", path, "--jq", jq])
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    raw: (path) => run(["api", path, "-H", "Accept: application/vnd.github.raw"]),
    graphql: (query, vars) => JSON.parse(run(graphqlArgs(query, vars))).data,
    // Reads of different repos side by side: one { value } or { error } per unit, in order, a failure never stopping the
    // others. A stand-in exec, as in the tests, reads them one by one. Each unit counts as one call.
    many: (units) => {
      const answer = (u, get) => {
        try {
          return { value: unitValue(u, get()) };
        } catch (error) {
          return { error };
        }
      };
      if (exec !== execFileSync) return units.map((u) => answer(u, () => run(unitArgs(u))));
      calls += units.length;
      graphqlCalls += units.filter((u) => u.graphql).length;
      const got = runManySettled("gh", units.map(unitArgs), { retryMs: RETRY_MS });
      return units.map((u, i) => (got[i].err ? { error: Object.assign(new Error(got[i].err.message), { stderr: got[i].err.stderr }) } : answer(u, () => got[i].out)));
    },
  };
}

const MERGED_Q = `query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){pullRequests(states:MERGED,first:50,after:$cursor,orderBy:{field:UPDATED_AT,direction:DESC}){pageInfo{hasNextPage endCursor} nodes{number createdAt mergedAt updatedAt commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}}`;
const OPEN_Q = `query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){pullRequests(states:OPEN,first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{number title createdAt baseRefName mergeable isDraft stack{number}}}}}`;
const historyQ = (n) =>
  `query($owner:String!,$name:String!,$since:GitTimestamp!,$cursor:String){repository(owner:$owner,name:$name){defaultBranchRef{target{... on Commit{history(since:$since,first:${n},after:$cursor){pageInfo{hasNextPage endCursor} nodes{oid committedDate message checkSuites(first:15){nodes{app{slug} checkRuns(first:6){nodes{name conclusion completedAt}}}}}}}}}}}`;

// A repo's pull requests merged since `since`, with their last commit's check state.
export function fetchMerged(gh, repo, since) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 20; page += 1) {
    const prs = gh.graphql(MERGED_Q, { owner: ORG, name: repo, cursor }).repository.pullRequests;
    for (const p of prs.nodes) {
      if (Date.parse(p.mergedAt) >= since) out.push({ number: p.number, createdAt: p.createdAt, mergedAt: p.mergedAt, rollup: p.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null });
    }
    const oldest = prs.nodes.at(-1);
    if (!prs.pageInfo.hasNextPage || !oldest || Date.parse(oldest.updatedAt) < since) break;
    cursor = prs.pageInfo.endCursor;
  }
  return out;
}

// Every open PR, 100 a page.
export function fetchOpen(gh, repo, wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)) {
  const read = () => {
    const out = [];
    let cursor = null;
    for (let page = 0; page < 30; page += 1) {
      const prs = gh.graphql(OPEN_Q, { owner: ORG, name: repo, cursor }).repository.pullRequests;
      out.push(...prs.nodes);
      if (!prs.pageInfo.hasNextPage) return out;
      cursor = prs.pageInfo.endCursor;
    }
    throw new Error("more than 3,000 open PRs; not all were read");
  };
  let prs = read();
  // GitHub computes mergeable lazily; the first read asks it to, the second gets the answer.
  if (prs.some((p) => p.mergeable === "UNKNOWN")) {
    wait(4000);
    prs = read();
  }
  return prs;
}

// The runs list answers at most 1,000 runs per filtered query, and one repo
// can start more than that in a day, so a range over the cap is cut into
// slices until each fits. Slices overlap by their inclusive ends; ids dedupe them.
export function fetchRuns(gh, repo, since, now) {
  const jq = "{t: .total_count, r: [.workflow_runs[] | {id, name, path, event, status, conclusion, head_sha, created_at, run_started_at, updated_at}]}";
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  const url = ([from, to], page) => `repos/${ORG}/${repo}/actions/runs?per_page=100&page=${page}&created=${iso(from)}..${iso(to)}`;
  // The whole range is read first: a quiet repo then costs one read, not one a week (#381). A range over
  // 1,000 runs is cut by its total into slices of equal time, about 800 runs each and at least a minute long,
  // down to 10 minutes, where its first 1,000 are kept. Each round reads the first page of every open range
  // side by side; the ranges that fit then read their other pages side by side, in one batch at the end.
  const slices = ([from, to], t) => {
    const k = Math.min(Math.ceil(t / 800), Math.floor((to - from) / 60_000));
    const edge = (i) => (i === 0 ? from : i === k ? to : Math.floor((from + ((to - from) * i) / k) / 1000) * 1000);
    return Array.from({ length: k }, (_, i) => [edge(i), edge(i + 1)]);
  };
  const out = new Map();
  const rest = [];
  let open = [[since, now]];
  while (open.length) {
    const firsts = gh.restMany(open.map((range) => url(range, 1)), jq);
    const split = [];
    open.forEach((range, i) => {
      const [{ t, r }, [from, to]] = [firsts[i], range];
      if (t > 1000 && to - from > 10 * 60_000) return split.push(...slices(range, t));
      for (const run of r) out.set(run.id, run);
      if (r.length) for (let page = 2; page <= Math.min(10, Math.ceil(t / 100)); page += 1) rest.push(url(range, page));
    });
    open = split;
  }
  for (let i = 0; i < rest.length; i += 100) for (const { r } of gh.restMany(rest.slice(i, i + 100), jq)) for (const run of r) out.set(run.id, run);
  return [...out.values()].filter((r) => Date.parse(r.created_at) >= since);
}

// A repo's default-branch commits since `since`, with their deploy check runs.
export function fetchHistory(gh, repo, since) {
  const out = [];
  let cursor = null;
  let size = 40;
  for (let page = 0; page < 60; page += 1) {
    let h;
    try {
      h = gh.graphql(historyQ(size), { owner: ORG, name: repo, since: new Date(since).toISOString(), cursor }).repository.defaultBranchRef?.target?.history;
    } catch (err) {
      // A repo with many check suites per commit can pass GitHub's per-query
      // resource limit; a smaller page asks for fewer nodes.
      if (size > 5 && /resource limits/i.test(String(err.stderr || err.message))) {
        size = Math.floor(size / 2);
        page -= 1;
        continue;
      }
      throw err;
    }
    if (!h) break;
    for (const c of h.nodes) {
      const deploys = c.checkSuites.nodes
        .filter((s) => s.app?.slug === WORKERS_APP)
        .flatMap((s) => s.checkRuns.nodes)
        .filter((r) => /Workers Builds/i.test(r.name));
      out.push({ oid: c.oid, committedDate: c.committedDate, message: c.message, deploys });
    }
    if (!h.pageInfo.hasNextPage) break;
    cursor = h.pageInfo.endCursor;
  }
  return out;
}

// The reads below are generators: each yields the gh read it needs next and receives its answer, so `drive` can run
// the reads of many repos side by side, one round of reads at a time. A read is { graphql: [query, vars] } (answered
// with its data), { rest: [paths], jq } (answered with one value per path) or a number of milliseconds to wait.
// fetchMerged, fetchOpen, fetchRuns and fetchHistory run one of them alone, as every caller did before.

// Each job's { value } or { error }, in order. Every round, the reads that jobs ask for go out together, up to
// org_many.mjs LIMIT at once; one job's failure ends that job and no other. A gh without `many` is read one by one.
export function drive(gh, jobs, wait = sleep) {
  const states = jobs.map((g) => ({ g, done: false }));
  const step = (s, fn) => {
    try {
      const r = fn();
      if (r.done) Object.assign(s, { done: true, value: r.value });
      else s.ask = r.value;
    } catch (error) {
      Object.assign(s, { done: true, error });
    }
  };
  const serve = (req) => (req.graphql ? gh.graphql(...req.graphql) : gh.restMany(req.rest, req.jq));
  states.forEach((s) => step(s, () => s.g.next()));
  for (let live = states.filter((s) => !s.done); live.length; live = states.filter((s) => !s.done)) {
    const asking = live.filter((s) => typeof s.ask !== "number");
    const pause = Math.max(0, ...live.filter((s) => typeof s.ask === "number").map((s) => s.ask));
    if (pause) wait(pause);
    live.filter((s) => typeof s.ask === "number").forEach((s) => step(s, () => s.g.next()));
    const answers = new Map();
    if (asking.length > 1 && gh.many) {
      const units = asking.flatMap((s) => (s.ask.graphql ? [s.ask] : s.ask.rest.map((rest) => ({ rest, jq: s.ask.jq }))));
      const got = gh.many(units);
      let at = 0;
      for (const s of asking) {
        const n = s.ask.graphql ? 1 : s.ask.rest.length;
        const mine = got.slice(at, at + n);
        at += n;
        const bad = mine.find((m) => m.error);
        answers.set(s, bad ? { error: bad.error } : { value: s.ask.graphql ? mine[0].value : mine.map((m) => m.value) });
      }
    } else {
      for (const s of asking) {
        try {
          answers.set(s, { value: serve(s.ask) });
        } catch (error) {
          answers.set(s, { error });
        }
      }
    }
    for (const s of asking) {
      const a = answers.get(s);
      step(s, () => (a.error ? s.g.throw(a.error) : s.g.next(a.value)));
    }
  }
  return states.map((s) => (s.error ? { error: s.error } : { value: s.value }));
}

const TREE = "... on Tree{entries{name object{... on Blob{text}}}}";
// Every repo's workflow files, git hooks and cloud-test list, in one GraphQL
// query: { repo: { workflows: [{ name, text }], hooks, cloudTest } | null }.
export function fetchFiles(gh, repos) {
  const q = repos
    .map((r, i) => `r${i}: repository(owner:"${ORG}",name:"${r}"){wf: object(expression:"HEAD:.github/workflows"){${TREE}} hooks: object(expression:"HEAD:.githooks"){${TREE}} ct: object(expression:"HEAD:.github/cloud-test.json"){... on Blob{text}}}`)
    .join(" ");
  const data = gh.graphql(`query{${q}}`, {});
  const files = (t) => (t?.entries ?? []).filter((e) => typeof e.object?.text === "string").map((e) => ({ name: e.name, text: e.object.text }));
  return Object.fromEntries(
    repos.map((r, i) => {
      const d = data?.[`r${i}`];
      return [r, d ? { workflows: files(d.wf).filter((f) => /\.ya?ml$/.test(f.name)), hooks: files(d.hooks), cloudTest: d.ct?.text ?? null } : null];
    }),
  );
}
