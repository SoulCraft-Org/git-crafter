// Page text never names a machine account (#229). A collector that reads the
// home folder runs its output through redact(): a home path prints as ~ and the
// home inside a project folder name (-Users-<name>-...) as -Users-<user>.
import os from 'node:os';

const HOME_PATH = /\/Users\/[^/\s"'`*]+/g;
const HOME_DASHED = /-Users-[A-Za-z0-9_]+(?![A-Za-z0-9_])/g;

// One string with this machine's home, and any /Users/<name>, taken out.
export function redactText(text, home = os.homedir()) {
  const h = String(home ?? '').replace(/\/+$/, '');
  let s = String(text);
  if (h) s = s.replace(new RegExp(`${escape(h)}(?=/|$|[^\\w.-])`, 'g'), '~');
  // Only a whole name: home /Users/someone leaves -Users-someonebob to the pattern below.
  if (/^\/Users\//.test(h)) s = s.replace(new RegExp(`${escape(h.replace(/[^A-Za-z0-9]/g, '-'))}(?![A-Za-z0-9_])`, 'g'), '-Users-<user>');
  return s.replace(HOME_PATH, '~').replace(HOME_DASHED, '-Users-<user>');
}

// Every string in a collector's output (sources, reasons, detail labels),
// redacted; numbers, nulls and the shape stay as they were.
export function redact(value, home = os.homedir()) {
  if (typeof value === 'string') return redactText(value, home);
  if (Array.isArray(value)) return value.map((v) => redact(v, home));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, home)]));
  return value;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
