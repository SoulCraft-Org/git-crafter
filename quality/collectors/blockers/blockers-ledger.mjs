// The costly ledger's rows for the Blockers metrics (blockers-metrics.mjs,
// blockers-guard.mjs): one row per blocker, and which blocks could be read.

import { HOUR, orNull, pct, round, sum } from './blockers-core.mjs';
import { verdict } from './blockers-github.mjs';

// The blocks whose outcome could be read: an unread one says nothing either way.
export const readable = (blocks) => blocks.filter((b) => b.outcome !== 'unread');

// One ledger row from the blocks, notes and timings that belong to it, summed
// over the last LAST_CALLS tool calls (the review loop and CI: the last
// LAST_PRS merged PRs). falseAlarm, a percent, stands in for blocks when the
// blocker is not a block (the review loop's clean rounds, CI's flaky checks).
export function ledgerRow(label, group, { fires, alarms = [], ms = [], tokens = [], falseAlarm }) {
  const row = {
    label,
    group,
    fires: Number.isFinite(fires) ? fires : null,
    // A block that cannot be read says nothing either way.
    false_alarm: falseAlarm !== undefined ? falseAlarm : readable(alarms).length ? pct(readable(alarms).filter((b) => b.falseAlarm).length, readable(alarms).length) : null,
    hours: orNull(ms, (xs) => round(sum(xs) / HOUR, 2)),
    tokens: orNull(tokens, (xs) => Math.round(sum(xs))),
  };
  return { ...row, value: row.tokens, verdict: verdict(row) };
}
