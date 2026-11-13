// The packs actions/pages checks out before the collect: one line per pinned
// pack in the Quality config, "owner/repo sha folder". A pack named by path
// is refused here as in any CI run (packs.mjs).
//
//   node quality/pack-checkouts.mjs [--config FILE]
import { pathToFileURL } from "node:url";

import { loadConfig } from "./config.mjs";

// The checkout lines for a loaded config's packs.
export function checkoutLines(config) {
  return config.packs.map((p) => `${p.spec.replace("@", " ")} ${p.dir}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [flag, file] = process.argv.slice(2);
  try {
    for (const line of checkoutLines(loadConfig({ file: flag === "--config" ? file : null, ci: true }))) console.log(line);
  } catch (err) {
    console.error(`quality: ${err.message}`);
    process.exit(2);
  }
}
