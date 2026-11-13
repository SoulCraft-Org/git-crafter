// The GitHub collector's lockfile and path-rule reads: installed packages and what pulls them in, deny-rule coverage and the allowed registries.
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

// A JSON file parsed, or null when it is missing.
export const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null);

/**
 * The packages an npm lockfile (version 2 or 3) installs: { path, name,
 * version, resolved }, workspace folders and links left out. Null when the
 * lockfile has no "packages" map.
 */
export function lockPackages(lock) {
  if (!lock?.packages || typeof lock.packages !== "object") return null;
  const out = [];
  for (const [p, info] of Object.entries(lock.packages)) {
    const at = p.lastIndexOf("node_modules/");
    if (at < 0 || info.link || !info.version) continue;
    out.push({ path: p, name: info.name ?? p.slice(at + "node_modules/".length), version: info.version, resolved: info.resolved ?? null });
  }
  return out;
}

/**
 * For each installed package path, the direct dependencies whose tree reaches
 * it: those the root package or a workspace folder ("site", "packages/x")
 * declares. Resolved the way Node does: the nearest node_modules folder up
 * from the package that needs it.
 */
export function pulledBy(lock) {
  const pkgs = lock.packages;
  const deps = (info) => Object.keys({ ...info.dependencies, ...info.devDependencies, ...info.optionalDependencies });
  const resolve = (from, dep) => {
    for (let dir = from; ; ) {
      if (dir && pkgs[`${dir}/node_modules/${dep}`]) return `${dir}/node_modules/${dep}`;
      const up = dir.lastIndexOf("/node_modules/");
      if (up < 0) return pkgs[`node_modules/${dep}`] ? `node_modules/${dep}` : null;
      dir = dir.slice(0, up);
    }
  };
  const reach = new Map();
  const roots = Object.keys(pkgs).filter((p) => !p.includes("node_modules/"));
  const direct = roots.flatMap((r) => deps(pkgs[r]).map((d) => [r, d]));
  for (const [r, d] of direct) {
    const queue = [resolve(r, d)].filter(Boolean);
    const seen = new Set();
    while (queue.length) {
      const p = queue.shift();
      if (seen.has(p) || !pkgs[p]) continue;
      seen.add(p);
      if (!reach.has(p)) reach.set(p, new Set());
      reach.get(p).add(d);
      for (const dep of Object.keys({ ...pkgs[p].dependencies, ...pkgs[p].optionalDependencies })) {
        const next = resolve(p, dep);
        if (next) queue.push(next);
      }
    }
  }
  return reach;
}

/** A path glob as Claude Code permission rules write them, as a whole-string pattern. */
export function globRegex(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

// A slash or backslash percent-encoded in a path: a server that decodes it reads another path,
// so team/..%2Fother, under team/ as text, could serve other/.
export const ENCODED_SEPARATOR = /%2f|%5c/i;

/**
 * The allowed registry a lockfile's resolved URL is on, and that URL parsed;
 * null when it is on none. On one means https, the registry's own origin, a
 * path under the registry's with no encoded separator, and no user or
 * password: parsed, never compared as text, so registry.npmjs.org.evil.example
 * is not npm's host.
 */
export function registryOf(resolved, registries) {
  const url = URL.canParse(resolved) ? new URL(resolved) : null;
  if (url?.protocol !== "https:" || url.username || url.password || ENCODED_SEPARATOR.test(url.pathname)) return null;
  const registry = registries.find((r) => url.origin === r.origin && url.pathname.startsWith(r.pathname));
  return registry ? { registry, url } : null;
}

/** git in the repo at root: each call's trimmed output; a failure throws. */
export const gitAt = (root) => (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
