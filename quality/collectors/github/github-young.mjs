// The GitHub collector's cooldown check: lockfile packages whose version was published fewer than cooldown days ago.
import { readJson, lockPackages, gitAt, registryOf, ENCODED_SEPARATOR, pulledBy } from "./github-lock.mjs";
import path from "node:path";
import { DAY, RegistryError } from "./github-core.mjs";

/** The lockfile's packages now and as git had it cooldown days ago, or a skip. */
function lockfileThen(root, now, cfg) {
  const lock = readJson(path.join(root, "package-lock.json"));
  const current = lockPackages(lock);
  if (!current) return { skip: "no package-lock.json with a packages map at the root" };
  const git = gitAt(root);
  try {
    if (git("rev-parse", "--is-shallow-repository") === "true") return { skip: "the checkout is shallow; the lockfile's history needs a full clone (fetch-depth: 0) or a --local run" };
    const commit = git("rev-list", "-1", `--before=@${Math.floor((now - cfg.cooldownDays * DAY) / 1000)}`, "HEAD");
    return { lock, current, before: commit ? lockAt(git, commit) : [] };
  } catch (err) {
    return { skip: `git could not read the lockfile's history: ${err.message.split("\n")[0]}` };
  }
}

/** The lockfile's packages at a commit; none when it had no lockfile then, so every entry is new. */
function lockAt(git, commit) {
  try {
    return lockPackages(JSON.parse(git("show", `${commit}:./package-lock.json`))) ?? [];
  } catch {
    return [];
  }
}

/** Only an allowed registry is asked, so a lockfile never points this process at another host. */
function splitByRegistry(fresh, registries) {
  const asked = [];
  let unasked = 0;
  for (const p of fresh) {
    const on = p.resolved && registryOf(p.resolved, registries);
    if (on) asked.push({ ...p, base: on.registry, download: on.url });
    else unasked++;
  }
  return { asked, unasked };
}

// Up to 8 requests at once. The first failure settles the metric, so it stops the rest, queued and in flight.
async function limit(items, fn) {
  const queue = [...items];
  const stop = new AbortController();
  await Promise.all(Array.from({ length: Math.min(8, queue.length) }, async () => {
    while (queue.length && !stop.signal.aborted) {
      try {
        await fn(queue.shift(), stop.signal);
      } catch (err) {
        stop.abort();
        throw err;
      }
    }
  }));
}

// A redirect is an error: it could lead anywhere, and only the registry's own host is asked.
async function askRegistry(fetchImpl, url, what, signal, method = "GET") {
  const res = await fetchImpl(url.href, { method, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) }).catch((err) => {
    throw new RegistryError(`the registry could not be read for ${what}: ${err.cause?.message ?? err.message}`);
  });
  if (!res.ok) throw new RegistryError(`the registry answered HTTP ${res.status} for ${what}`);
  return res;
}

/**
 * Sets each package's document URL, and answers the skip text for the first
 * whose name would leave its registry. The name is encoded whole, as npm
 * writes @scope%2Fname, so no name can leave the registry's origin; the
 * scope's %2F is the only encoded separator a document's path may hold.
 */
function documentUrls(unsure) {
  for (const q of unsure) {
    q.doc = new URL(encodeURIComponent(q.name).replace(/^%40/, "@"), q.base);
    const rest = q.doc.pathname.slice(q.base.pathname.length).replace(/^@[^/]*?%2F/i, "");
    if (q.doc.origin !== q.base.origin || !q.doc.pathname.startsWith(q.base.pathname) || rest.includes("/") || ENCODED_SEPARATOR.test(rest)) {
      return `${q.name} names a document outside ${q.base.href}`;
    }
  }
  return null;
}

/**
 * Lockfile packages whose version was published fewer than cooldown days ago,
 * with no cache. A version that new can only have entered the lockfile within
 * the cooldown, since it was published before it was added, so only entries
 * missing from the lockfile as git had it cooldown days ago are checked. Each
 * one's download (its resolved URL, on an allowed registry) answers a HEAD
 * with Last-Modified, which is never before the publish: an old header proves
 * an old version, with no body read. Only a recent one, or one with no
 * header, costs a fetch of the package's full document for its real publish
 * time; a re-uploaded old file shows up there as old. Any publish time that
 * cannot be read makes the whole metric could_not_check, never "old".
 */
export async function youngPackages(root, now, cfg, fetchImpl) {
  const then = lockfileThen(root, now, cfg);
  if (then.skip) return then;
  const { lock, current, before } = then;
  const had = new Set(before.map((p) => `${p.name}@${p.version}`));
  const fresh = current.filter((p) => !had.has(`${p.name}@${p.version}`));
  const { asked, unasked } = splitByRegistry(fresh, cfg.registries);
  const cap = cfg.maxRegistryReads;
  if (asked.length > cap) return { skip: `${asked.length} downloads to ask for Last-Modified, over params.max_registry_reads (${cap})` };
  const cooldown = cfg.cooldownDays * DAY;
  await limit(asked, async (q, signal) => {
    const res = await askRegistry(fetchImpl, q.download, `${q.name} ${q.version}`, signal, "HEAD");
    q.headerAt = Date.parse(res.headers.get("last-modified") ?? "");
  });
  const unsure = asked.filter((q) => !(now - q.headerAt >= cooldown));
  const outside = documentUrls(unsure);
  if (outside) return { skip: outside };
  const docs = [...new Map(unsure.map((q) => [q.doc.href, q])).values()];
  if (asked.length + docs.length > cap) return { skip: `${asked.length} HEADs and ${docs.length} documents to read from the registry, over params.max_registry_reads (${cap})` };
  const times = new Map();
  await limit(docs, async (d, signal) => {
    const res = await askRegistry(fetchImpl, d.doc, d.name, signal);
    times.set(d.doc.href, (await res.json()).time ?? {});
  });
  for (const q of unsure) q.publishedAt = Date.parse(times.get(q.doc.href)?.[q.version] ?? "");
  const missing = unsure.filter((q) => !Number.isFinite(q.publishedAt));
  if (missing.length) return { skip: `no publish time for ${missing.slice(0, 3).map((q) => `${q.name} ${q.version}`).join(", ")}${missing.length > 3 ? ` and ${missing.length - 3} more` : ""}` };
  const young = unsure
    .map((q) => ({ ...q, days: (now - q.publishedAt) / DAY }))
    .filter((q) => q.days < cfg.cooldownDays)
    .sort((a, b) => a.days - b.days);
  return { young, fresh: fresh.length, heads: asked.length, docs: docs.length, unasked, reach: young.length ? pulledBy(lock) : new Map() };
}
