// The GitHub collector's Caches metric: how much of the Actions cache storage the repo uses.
import { measured, count, pct, round1 } from "./github-core.mjs";

const GIB = 1024 ** 3;

/** Each metric reads through the loaders and returns measured(...) or skip(...). */
export const CACHE_METRICS = {
  // Caches -------------------------------------------------------------------
  // State now, as GitHub refreshes it (about every five minutes). At the limit GitHub deletes the least recently
  // accessed caches first, so a share near 100 means a cache is already being evicted before its 7 days are up.
  "actions.cache_storage_pct": {
    source: "state: gh api repos/{repo}/actions/cache/usage (active_caches_size_in_bytes) against actions/cache/storage-limit (max_cache_size_gb), else params.cache_limit_gb",
    async run(L, { cfg }) {
      const usage = await L.cacheUsage();
      const limitGb = (await L.cacheLimit())?.max_cache_size_gb ?? cfg.cacheLimitGb;
      return measured(pct(usage.active_caches_size_in_bytes, limitGb * GIB), [
        { label: "stored", value: round1(usage.active_caches_size_in_bytes / GIB), unit: "GB" },
        { label: "limit", value: limitGb, unit: "GB" },
        count("active caches", usage.active_caches_count),
      ]);
    },
  },
};
