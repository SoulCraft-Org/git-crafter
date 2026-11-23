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
import { assess, verdict } from "./merge_pr.mjs";

const USAGE = "usage: node tools/merge_pr_stack.mjs --repo owner/name --prs N:<sha>,N:<sha>,... --followups <#n,PVTI_...|none> [--base main] [--wait seconds] [--check]";
const STEP = 5;

// The command line as options, or { problem }.
function parseArgs(argv) {
  const o = { base: "main", wait: 60, check: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--check") o.check = true;
    else if (["--repo", "--prs", "--followups", "--base", "--wait"].includes(argv[i]) && argv[i + 1]) o[argv[i].slice(2)] = argv[++i];
    else return { problem: `unknown or incomplete argument ${argv[i]}` };
  }
  const prs = String(o.prs ?? "").split(",").map((p) => p.split(":"));
  if (!/^[\w.-]+\/[\w.-]+$/.test(o.repo ?? "")) return { problem: "--repo must be owner/name" };
  if (prs.length < 2 || prs.some(([n, sha]) => !/^[1-9]\d*$/.test(n) || !/^[0-9a-f]{40}$/.test(sha ?? ""))) return { problem: "--prs must be two or more N:<40-hex sha>, bottom up" };
  const items = String(o.followups ?? "").split(",").map((i) => i.trim());
  if (o.followups !== "none" && !items.every((i) => /^(#\d+|PVTI_[\w-]+)$/.test(i))) return { problem: "--followups is required: #<digits> or PVTI_... items, comma separated, or none" };
  return /^\d+$/.test(String(o.wait)) ? { ...o, followups: items.join(", "), wait: Number(o.wait), prs: prs.map(([pr, sha]) => ({ pr, sha })) } : { problem: "--wait must be seconds" };
}

/** The command line. `run` is gh, `sleep` the wait between reads (both injectable for tests). Returns the exit code. */
export async function main(argv = process.argv.slice(2), { run = ghRunner(), sleep = (ms) => new Promise((done) => setTimeout(done, ms)), log = console.log, error = console.error } = {}) {
  const o = parseArgs(argv);
  if (o.problem) {
    error(`${o.problem}\n${USAGE}`);
    return 2;
  }
  const read = (route) => JSON.parse(run(["api", route]));
  const base = (i, under) => (i ? under.pull.head.ref : o.base);
  try {
    const judged = [];
    for (const [i, p] of o.prs.entries()) {
      judged.push({ ...p, ...(await assess({ read, repo: o.repo, ...p, base: base(i, judged[i - 1]), wait: o.wait, sleep })) });
      log(`${judged[i].act} #${p.pr}: ${judged[i].why}`);
    }
    if (judged.some((d) => d.act !== "merge")) return judged.some((d) => d.act === "refuse") ? 1 : 3;
    const want = o.prs.map((p) => p.pr).join();
    const open = read(`repos/${o.repo}/stacks?per_page=100`).filter((s) => s.open && s.pull_requests.some((p) => want.split(",").includes(String(p.number))));
    if (open.some((s) => s.pull_requests.map((p) => p.number).join() !== want)) throw new Error(`an open stack holds ${open[0].pull_requests.map((p) => `#${p.number}`).join(", ")}, not #${want.replaceAll(",", ", #")}`);
    if (o.check) return 0;
    if (!open.length) run(["api", "-X", "POST", `repos/${o.repo}/stacks`, ...o.prs.flatMap((p) => ["-F", `pull_requests[]=${p.pr}`])]);
    for (const p of o.prs) verdict(run, { repo: o.repo, followups: o.followups, ...p });
    const top = o.prs.at(-1);
    run(["api", "-X", "PUT", `repos/${o.repo}/pulls/${top.pr}/merge-async`, "-f", `sha=${top.sha}`, "-f", "merge_method=squash"]);
    for (let waited = 0; !read(`repos/${o.repo}/pulls/${top.pr}`).merged; waited += STEP) {
      if (waited >= o.wait) return log(`wait #${top.pr}: the merge has not finished; read repos/${o.repo}/pulls/${top.pr}/merge-async/<id>`) ?? 3;
      await sleep(STEP * 1000);
    }
    const left = o.prs.filter((p) => !read(`repos/${o.repo}/pulls/${p.pr}`).merged);
    if (left.length) throw new Error(`merged #${top.pr} but not ${left.map((p) => `#${p.pr}`).join(", ")}`);
    log(`merged ${o.prs.map((p) => `#${p.pr}`).join(", ")}`);
    return 0;
  } catch (err) {
    error(`merge_pr_stack: ${err.message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
