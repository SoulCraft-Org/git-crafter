// Reads the GitHub repo switches templates/setup.json lists, through gh api.
//
//   node tools/apply_setup.mjs --repo owner/name [--check]
//
// Each row prints as same, would change, by hand, optional, org's rules, no
// value or unreadable; nothing changes. --check exits 1 when a row that is not
// optional differs or cannot be read. Exit 2: a usage error.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { reader, rowState } from "./apply_setup_rows.mjs";

/** The setup list this tool reads by default. */
export const SETUP = fileURLToPath(new URL("../templates/setup.json", import.meta.url));
const USAGE = "usage: node tools/apply_setup.mjs --repo owner/name [--check]";

/** gh as a function of its arguments and stdin: its stdout, or an Error carrying the HTTP status gh names. */
export function ghRunner(exec = spawnSync) {
  const env = { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" };
  return (args, input) => {
    const r = exec("gh", args, { encoding: "utf8", input, env, maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
    if (r.error) throw r.error;
    if (r.status === 0) return r.stdout;
    const err = new Error(`gh ${args.slice(0, 4).join(" ")}: ${(r.stderr ?? "").trim()}`);
    err.status = Number(/HTTP (\d{3})/.exec(r.stderr ?? "")?.[1]) || null;
    throw err;
  };
}

const SWITCHES = new Set(["--check"]);
const OPTIONS = new Set(["--repo"]);

// The command line as options, or { problem }.
function parseArgs(argv) {
  const opts = { check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (SWITCHES.has(a)) opts[a.slice(2)] = true;
    else if (OPTIONS.has(a) && argv[i + 1]) opts[a.slice(2)] = argv[++i];
    else return { problem: `unknown or incomplete argument ${a}` };
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(opts.repo ?? "")) return { problem: "--repo must be owner/name" };
  return opts;
}

// The context every row reads through: cached GETs and GraphQL, no per-repo values and no optional row turned on.
function context(run, owner, repo) {
  const read = reader(run);
  const graphql = (query) => JSON.parse(run(["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `repo=${repo}`]));
  const vars = { owner, repo, node_id: () => read(`repos/${owner}/${repo}`)?.node_id };
  return { run, read, graphql, vars, optionalOn: new Set() };
}

/**
 * The command line. `run` is gh (injectable for tests), `setup` the setup
 * list's path, `log` and `error` where lines go. Returns the exit code.
 */
export function main(argv = process.argv.slice(2), { run = ghRunner(), setup = SETUP, log = console.log, error = console.error } = {}) {
  const opts = parseArgs(argv);
  if (opts.problem) {
    error(`${opts.problem}\n${USAGE}`);
    return 2;
  }
  const [owner, repo] = opts.repo.split("/");
  const ctx = context(run, owner, repo);
  const results = JSON.parse(readFileSync(setup, "utf8")).rows.map((row) => ({ row, ...rowState(row, ctx) }));
  return report(results, opts, log);
}

// Prints one line per row and a tally; the exit code is 1 for a failed row under --check.
function report(results, opts, log) {
  for (const r of results) log(`${r.status.padEnd(13)} ${r.row.id}${r.note ? `  ${r.note}` : ""}`);
  const tally = Object.entries(Object.groupBy(results, (r) => r.status)).map(([s, rs]) => `${rs.length} ${s}`);
  log(`${opts.repo}: ${tally.join(", ")} (nothing changed)`);
  const failed = opts.check ? results.filter((r) => r.failed) : [];
  if (failed.length) log(`check failed: ${failed.map((r) => r.row.id).join(", ")}`);
  return failed.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
