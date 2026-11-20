// The key gh actions-lock files a `uses:` reference under in actions.lock, so a collector can match a workflow's reference to the lock.

/**
 * `owner/repo@ref` for a `uses:` value: the sub-path of an action or reusable
 * workflow (`owner/repo/sub/path@ref`) dropped, and owner and repo in lower
 * case, as GitHub names are not case-sensitive. A value with no `owner/repo@`
 * (a local path, a docker:// image) comes back unchanged.
 */
export const lockKey = (uses) => String(uses).trim().replace(/^([^/@\s]+\/[^/@\s]+)(?:\/[^@\s]*)?@/, (_, repo) => `${repo.toLowerCase()}@`);
