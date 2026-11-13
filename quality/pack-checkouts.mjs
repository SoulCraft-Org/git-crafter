// The packs actions/pages checks out before the collect: for each pinned pack
// in the Quality config, owner/repo, sha and folder, each ended by a NUL, the
// one byte a path cannot hold. A pack named by path is refused here as in any
// CI run (packs.mjs).
//
//   node quality/pack-checkouts.mjs [--config FILE]
import { pathToFileURL } from "node:url";

import { loadConfig } from "./config.mjs";

// The checkout fields for a loaded config's packs: [owner/repo, sha, folder] each.
export function checkoutFields(config) {
  return config.packs.map((p) => [...p.spec.split("@"), p.dir]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [flag, file] = process.argv.slice(2);
  try {
    for (const fields of checkoutFields(loadConfig({ file: flag === "--config" ? file : null, ci: true }))) process.stdout.write(fields.map((f) => `${f}\0`).join(""));
  } catch (err) {
    console.error(`quality: ${err.message}`);
    process.exit(2);
  }
}
