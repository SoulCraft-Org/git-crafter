// Merges a reviewed stack of pull requests through GitHub's stack API: each pull request's base, head and latest
// checks are judged as merge_pr.mjs judges one, the stack is joined if it is not, each verdict is posted bottom up,
// and the top merges with everything under it.
//
//   node tools/merge_pr_stack.mjs --repo owner/name --prs N:<sha>,N:<sha>,... --followups <#n,PVTI_...|none> [--base main] [--wait 60] [--check]
//
// --prs lists the pull requests bottom up, each with the 40-hex head its review passed. The bottom pull request's
// base must be --base and each other's the head branch of the one under it. An open stack that holds other pull
// requests, or the same ones in another order, is refused. Exit 0 merged (or ready under --check), 1 refused,
// 2 usage, 3 not yet: a check pending, mergeable UNKNOWN past --wait, or the merge still running past --wait.
// The merge-async answer's shape is not read: the top pull request's own state says whether it merged.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ghRunner } from "./apply_setup.mjs";
import { assess, readFlags, readFollowups, verdict } from "./merge_pr.mjs";

const USAGE = "usage: node tools/merge_pr_stack.mjs --repo owner/name --prs N:<sha>,N:<sha>,... --followups <#n,PVTI_...|none> [--base main] [--wait seconds] [--check]";
const STEP = 5;

// The command line as options, or { problem }.
function parseArgs(argv) {
  const o = readFlags(argv, ["--repo", "--prs", "--followups", "--base", "--wait"]);
  if (o.problem) return o;
  const prs = String(o.prs ?? "").split(",").map((p) => p.split(":"));
  if (!/^[\w.-]+\/[\w.-]+$/.test(o.repo ?? "")) return { problem: "--repo must be owner/name" };
  if (prs.length < 2 || prs.some(([n, sha]) => !/^[1-9]\d*$/.test(n) || !/^[0-9a-f]{40}$/.test(sha ?? ""))) return { problem: "--prs must be two or more N:<40-hex sha>, bottom up" };
  const f = readFollowups(o.followups);
  if (f.problem) return f;
  return /^\d+$/.test(String(o.wait)) ? { ...o, ...f, wait: Number(o.wait), prs: prs.map(([pr, sha]) => ({ pr, sha })) } : { problem: "--wait must be seconds" };
}

// Judges each pull request bottom up; each one's base is the head branch of the one under it.
async function judgeLayers(o, { read, sleep, log }) {
  const judged = [];
  for (const [i, p] of o.prs.entries()) {
    const base = i ? judged[i - 1].pull.head.ref : o.base;
    judged.push({ ...p, ...(await assess({ read, repo: o.repo, ...p, base, wait: o.wait, sleep })) });
    log(`${judged[i].act} #${p.pr}: ${judged[i].why}`);
  }
  return judged;
}

// The open stacks that hold these pull requests; throws when one holds others or the same ones in another order.
function openStacks(o, read) {
  const want = o.prs.map((p) => p.pr).join();
  const open = read(`repos/${o.repo}/stacks?per_page=100`).filter((s) => s.open && s.pull_requests.some((p) => want.split(",").includes(String(p.number))));
  if (open.some((s) => s.pull_requests.map((p) => p.number).join() !== want)) throw new Error(`an open stack holds ${open[0].pull_requests.map((p) => `#${p.number}`).join(", ")}, not #${want.replaceAll(",", ", #")}`);
  return open;
}

// True once the top pull request reads merged, re-read for up to --wait seconds.
async function topMerged(o, { read, sleep }, top) {
  for (let waited = 0; !read(`repos/${o.repo}/pulls/${top.pr}`).merged; waited += STEP) {
    if (waited >= o.wait) return false;
    await sleep(STEP * 1000);
  }
  return true;
}

// merge-async pins only the top sha, so every layer's head is read again just before the PUT; throws when one moved.
function layersUnmoved(o, read) {
  const moved = o.prs.filter((p) => read(`repos/${o.repo}/pulls/${p.pr}`).head.sha !== p.sha);
  if (moved.length) throw new Error(`${moved.map((p) => `#${p.pr}`).join(", ")} moved since its review, so nothing merged`);
}

// Throws when a pull request under the merged top did not merge with it.
function allMerged(o, read, top) {
  const left = o.prs.filter((p) => !read(`repos/${o.repo}/pulls/${p.pr}`).merged);
  if (left.length) throw new Error(`merged #${top.pr} but not ${left.map((p) => `#${p.pr}`).join(", ")}`);
}

/** The command line. `run` is gh, `sleep` the wait between reads (both injectable for tests). Returns the exit code. */
export async function main(argv = process.argv.slice(2), { run = ghRunner(), sleep = (ms) => new Promise((done) => setTimeout(done, ms)), log = console.log, error = console.error } = {}) {
  const o = parseArgs(argv);
  if (o.problem) {
    error(`${o.problem}\n${USAGE}`);
    return 2;
  }
  const read = (route) => JSON.parse(run(["api", route]));
  try {
    const judged = await judgeLayers(o, { read, sleep, log });
    if (judged.some((d) => d.act !== "merge")) return judged.some((d) => d.act === "refuse") ? 1 : 3;
    const open = openStacks(o, read);
    if (o.check) return 0;
    if (!open.length) run(["api", "-X", "POST", `repos/${o.repo}/stacks`, ...o.prs.flatMap((p) => ["-F", `pull_requests[]=${p.pr}`])]);
    for (const p of o.prs) verdict(run, { repo: o.repo, followups: o.followups, ...p });
    const top = o.prs.at(-1);
    layersUnmoved(o, read);
    run(["api", "-X", "PUT", `repos/${o.repo}/pulls/${top.pr}/merge-async`, "-f", `sha=${top.sha}`, "-f", "merge_method=squash"]);
    if (!(await topMerged(o, { read, sleep }, top))) return log(`wait #${top.pr}: the merge has not finished; read repos/${o.repo}/pulls/${top.pr}/merge-async/<id>`) ?? 3;
    allMerged(o, read, top);
    log(`merged ${o.prs.map((p) => `#${p.pr}`).join(", ")}`);
    return 0;
  } catch (err) {
    error(`merge_pr_stack: ${err.message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
