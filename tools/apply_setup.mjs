// Sets the GitHub switches a setup list names, through gh api: a repo's from
// templates/setup.json, or an organization's, a user's or an enterprise's from
// each *.json file in templates/setup/org, user or enterprise (a missing folder
// holds no rows).
//
//   node tools/apply_setup.mjs --repo owner/name | --org name | --user login | --enterprise slug
//     [--values file.json] [--only id,id] [--apply] [--check]
//
// Paths and bodies fill {owner} and {repo}, {org}, {user} or {enterprise}, and
// {node_id} (an enterprise's comes from the values file). Under --org a ruleset
// row reads the organization's rulesets, and one counts only when it reaches
// every repo.
// A dry run by default: each row prints as same, would change, by hand,
// optional, org's rules, no value or unreadable, and nothing changes.
// --apply sets each "would change" row, then reads it back: changed or failed;
// after the first failure the rest read skipped and are not written.
// --only names the rows --apply may set; the others read as a dry run does.
// --check exits 1 when a row that is not optional differs (after --apply, as
// read back) or cannot be read. --values holds the per-repo values (topics,
// homepage, description) and optional_on, the optional rows to turn on.
// Exit 2: a usage error.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fill, reader, rowState } from "./apply_setup_rows.mjs";

/** The setup list --repo reads by default; --org, --user and --enterprise read the folder of that name in SETUP_DIR. */
export const SETUP = fileURLToPath(new URL("../templates/setup.json", import.meta.url));
const SETUP_DIR = fileURLToPath(new URL("../templates/setup/", import.meta.url));
const USAGE = "usage: node tools/apply_setup.mjs --repo owner/name | --org name | --user login | --enterprise slug [--values file.json] [--only id,id] [--apply] [--check]";

// Each scope: the shape of its name, the placeholders it fills, and the route that holds its node_id.
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const SCOPES = {
  repo: { shape: /^[\w.-]+\/[\w.-]+$/, spelled: "owner/name", vars: (n) => ({ owner: n.split("/")[0], repo: n.split("/")[1] }), node: "repos/{owner}/{repo}" },
  org: { shape: LOGIN, spelled: "an organization login", vars: (org) => ({ org }), node: "orgs/{org}" },
  user: { shape: LOGIN, spelled: "a user login", vars: (user) => ({ user }), node: "users/{user}" },
  enterprise: { shape: LOGIN, spelled: "an enterprise slug", vars: (enterprise) => ({ enterprise }) },
};

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

const SWITCHES = new Set(["--apply", "--check"]);
const OPTIONS = new Set(["--values", "--only", ...Object.keys(SCOPES).map((s) => `--${s}`)]);

// The command line as options, or { problem }.
function parseArgs(argv) {
  const opts = { apply: false, check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (SWITCHES.has(a)) opts[a.slice(2)] = true;
    else if (OPTIONS.has(a) && argv[i + 1]) opts[a.slice(2)] = argv[++i];
    else return { problem: `unknown or incomplete argument ${a}` };
  }
  const named = Object.keys(SCOPES).filter((s) => s in opts);
  if (named.length !== 1) return { problem: "name one of --repo, --org, --user or --enterprise" };
  const [scope] = named;
  if (!SCOPES[scope].shape.test(opts[scope])) return { problem: `--${scope} must be ${SCOPES[scope].spelled}` };
  return { ...opts, scope, name: opts[scope] };
}

// The rows at `setup`: a file's, or those of each *.json file in a folder in name order; a missing path holds none.
function loadRows(setup) {
  if (!existsSync(setup)) return [];
  if (!statSync(setup).isDirectory()) return JSON.parse(readFileSync(setup, "utf8")).rows;
  return readdirSync(setup).filter((f) => f.endsWith(".json")).sort().flatMap((f) => loadRows(join(setup, f)));
}

// The values file as { values, optionalOn }, or { problem }.
function loadValues(file, root) {
  if (!file) return { values: {}, optionalOn: new Set() };
  try {
    const { comment: _, optional_on: on = [], ...values } = JSON.parse(readFileSync(resolve(root, file), "utf8"));
    if (!Array.isArray(on)) return { problem: `optional_on in ${file} must be a list of row ids` };
    return { values, optionalOn: new Set(on) };
  } catch (err) {
    return { problem: `cannot read ${file}: ${err.message}` };
  }
}

// Sets one row through gh api, then reads it back.
function applyRow(row, ctx) {
  try {
    const args = ["api", "-X", row.method, fill(row.path, ctx.vars)];
    const body = row.body === undefined ? undefined : JSON.stringify(fill(row.body, ctx.vars));
    ctx.run(body === undefined ? args : [...args, "--input", "-"], body);
  } catch (err) {
    return { status: "failed", note: err.message, failed: true };
  }
  ctx.read.forget();
  const back = rowState(row, ctx);
  return back.status === "same" ? { status: "changed", note: "read back" } : { status: "failed", note: `read back ${back.status}: ${back.note}`, failed: true };
}

// The context every row reads through: cached GETs, GraphQL over the scope's names, the values, the optional rows turned on and the scope.
function context(run, { scope, name }, { values, optionalOn }) {
  const read = reader(run);
  const named = SCOPES[scope].vars(name);
  const graphql = (query) => JSON.parse(run(["api", "graphql", "-f", `query=${query}`, ...Object.entries(named).flatMap(([k, v]) => ["-f", `${k}=${v}`])]));
  const node = SCOPES[scope].node && { node_id: () => read(fill(SCOPES[scope].node, named))?.node_id };
  return { run, read, graphql, vars: { ...values, ...named, ...node }, optionalOn, scope };
}

// The first usage problem: from the options, the values file, --only or optional_on; null when none.
function problemOf(loaded, rows, only) {
  const missing = (ids) => [...(ids ?? [])].filter((id) => !rows.some((r) => r.id === id));
  if (loaded.problem) return loaded.problem;
  if (missing(only).length) return `--only names no such row: ${missing(only).join(", ")}`;
  return missing(loaded.optionalOn).length ? `optional_on names no such row: ${missing(loaded.optionalOn).join(", ")}` : null;
}

// Each row's result in order; under --apply a would-change row is set (only those named by --only), and after the first failed write the rest read skipped.
function resultsOf(rows, ctx, opts, only) {
  const results = [];
  let stopped = false;
  for (const row of rows) {
    const state = rowState(row, ctx);
    if (!opts.apply || state.status !== "would change" || (only && !only.has(row.id))) results.push({ row, ...state });
    else if (stopped) results.push({ row, status: "skipped", note: "an earlier write failed", failed: true });
    else {
      const done = applyRow(row, ctx);
      stopped = Boolean(done.failed);
      results.push({ row, ...done });
    }
  }
  return results;
}

/**
 * The command line. `run` is gh (injectable for tests), `setup` the setup
 * list's path (a file, or a folder of them; the scope's own by default),
 * `root` where --values resolves, `log` and `error` where lines go. Returns
 * the exit code.
 */
export function main(argv = process.argv.slice(2), { run = ghRunner(), setup, root = process.cwd(), log = console.log, error = console.error } = {}) {
  const opts = parseArgs(argv);
  const loaded = opts.problem ? opts : loadValues(opts.values, root);
  const rows = opts.problem ? [] : loadRows(setup ?? (opts.scope === "repo" ? SETUP : join(SETUP_DIR, opts.scope)));
  const only = opts.only ? new Set(opts.only.split(",")) : null;
  const problem = problemOf(loaded, rows, only);
  if (problem) {
    error(`${problem}
${USAGE}`);
    return 2;
  }
  if (only && !opts.apply) log("note: --only names rows for --apply; without --apply nothing is set");
  return report(resultsOf(rows, context(run, opts, loaded), opts, only), opts, log);
}

// Prints one line per row and a tally; the exit code: 1 for a failed write, or a failed row under --check.
function report(results, opts, log) {
  for (const r of results) log(`${r.status.padEnd(13)} ${r.row.id}${r.note ? `  ${r.note}` : ""}`);
  const unset = results.filter((r) => r.status === "no value");
  if (unset.length) log(`warning: ${unset.length} row(s) read no value and never fail --check: ${unset.map((r) => r.row.id).join(", ")}`);
  const tally = Object.entries(Object.groupBy(results, (r) => r.status)).map(([s, rs]) => `${rs.length} ${s}`);
  log(`${opts.scope === "repo" ? "" : `${opts.scope} `}${opts.name}: ${tally.join(", ") || "no rows"}${opts.apply ? "" : " (dry run: nothing changed)"}`);
  const failed = opts.check ? results.filter((r) => r.failed) : [];
  if (failed.length) log(`check failed: ${failed.map((r) => r.row.id).join(", ")}`);
  return failed.length || results.some((r) => r.status === "failed") ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
