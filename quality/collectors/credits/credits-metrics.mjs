// The Credits tab's metrics from its allowance rows (credits.mjs allowances):
// each takes one context { rows, p, src, readAt, now, overLanes }.

export const DAY = 864e5;
// A could_not_check value with its reason and source.
export const cnc = (reason, source) => ({ could_not_check: reason, source });
// Rounds to d decimals (one by default).
export const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
// True for a finite number.
export const finite = (n) => typeof n === 'number' && Number.isFinite(n);

// Every Credits metric from the usage guard's lane rows.
export function metricsFrom(rows, { p, src, now }) {
  const readAt = now.toISOString();
  const overLanes = new Set(rows.filter((r) => r.status === 'over').map((r) => r.lane));
  const ctx = { rows, p, src, readAt, now, overLanes };
  return {
    'credits.idle_replaceable': idleMetric(ctx),
    ...poolMetrics(ctx),
    'credits.highest_used_share': highestMetric(ctx),
    'credits.unclaimed_free': unclaimedMetric(ctx),
    'credits.usage_read_share': readShareMetric(ctx),
    'credits.registry_age_days': ageMetric(ctx),
  };
}

function idleMetric({ rows, src, readAt, overLanes }) {
  const idle = rows.filter((r) => overLanes.has(r.lane) && (r.status === 'unclaimed' || r.status === 'idle'));
  // The table shows no usage note; the source column stays for provenance.
  const detail = rows.map(({ usage_note, ...r }) => ({ ...r, value: r.unused, replaces: overLanes.has(r.lane) && r.status !== 'over' }));
  return {
    value: idle.length,
    detail,
    source: `${src}; a lane is over budget when an allowance in it has used all it includes this cycle (${[...overLanes].join(', ') || 'none'} today); counted: allowances in such a lane that are unclaimed, or claimed with use known to be under the limit`,
    read_at: readAt,
  };
}

// The CI pools: used against what each includes this cycle, a running total.
function poolMetrics({ rows, p, src, readAt }) {
  const out = {};
  for (const [id, poolId] of Object.entries(p.pool_metrics ?? {})) {
    const r = rows.find((x) => x.id === poolId);
    out[id] = r && finite(r.used_share) && !r.used_floor
      ? { value: r.used_share, detail: [{ label: 'Used this cycle', value: r.used, unit: r.unit }, { label: 'Left this cycle', value: r.unused, unit: r.unit }], source: `${src}; ${r.label}, a pool every repo draws on: used this cycle against ${r.allowance} ${r.unit} included (${r.source})`, read_at: readAt }
      : cnc(r ? `${r.label}'s org total is not read: ${r.used_floor ? `at least ${r.used} ${r.unit} used; ` : ''}${r.claim_needs || r.usage_note || 'no reader'}` : `${poolId} is not in params.allowances`, src);
  }
  return out;
}

// The CI pools have their own rows above; this one judges the rest.
function highestMetric({ rows, src, readAt }) {
  const top = rows.filter((r) => finite(r.used_share) && !r.used_floor && !r.pool).sort((a, b) => b.used_share - a.used_share);
  if (!top.length) return cnc('no allowance has a read running total', src);
  return { value: top[0].used_share, detail: top.map((r) => ({ label: r.label, value: r.used_share, unit: '%' })), source: `${src}; the highest share of any read allowance outside the CI pools used this cycle, a running total`, read_at: readAt };
}

function unclaimedMetric({ rows, p, src, readAt }) {
  const unclaimed = rows.filter((r) => r.status === 'unclaimed');
  return {
    value: unclaimed.length,
    detail: unclaimed.map((r) => ({ label: `${r.label}: ${r.claim_needs}`, value: 1, unit: '' })),
    source: `${src}; free allowances in ${[...(p.claim_lanes ?? [])].join(', ') || 'no lane (params.claim_lanes)'} that the org has not claimed now, each with what claiming it needs`,
    read_at: readAt,
  };
}

function readShareMetric({ rows, src, readAt }) {
  const claimed = rows.filter((r) => r.claimed);
  if (!claimed.length) return cnc('no claimed allowance in params.allowances', src);
  // A floor (some repos unread) is not a read running total.
  const read = claimed.filter((r) => r.used !== null && !r.used_floor);
  const unread = claimed.filter((r) => !read.includes(r));
  const pending = unread.filter((r) => !r.unreadable && /key|login|token/i.test(r.claim_needs));
  return {
    value: round((read.length / claimed.length) * 100),
    detail: [
      { label: 'Use read', value: read.length, unit: 'allowances' },
      { label: 'No API reads its use', value: unread.filter((r) => r.unreadable).length, unit: 'allowances' },
      { label: 'Needs a key or login', value: pending.length, unit: 'allowances' },
      { label: 'No reader yet', value: unread.filter((r) => !r.unreadable && !pending.includes(r)).length, unit: 'allowances' },
    ],
    source: `${src}; claimed allowances whose use this cycle is read. Not read: ${unread.map((r) => `${r.label} (${r.claim_needs || r.usage_note || 'no reader'})`).join('; ') || 'none'}`,
    read_at: readAt,
  };
}

function ageMetric({ rows, src, readAt, now }) {
  const dates = rows.map((r) => Date.parse(r.checked ?? '')).filter(Number.isFinite);
  if (!dates.length) return cnc('no allowance carries a read date', src);
  const days = (t) => Math.max(Math.floor((now.getTime() - t) / DAY), 0);
  return {
    value: days(Math.min(...dates)),
    detail: rows
      .filter((r) => r.checked)
      .sort((a, b) => String(a.checked).localeCompare(String(b.checked)))
      .slice(0, 8)
      .map((r) => ({ label: r.label, value: days(Date.parse(r.checked)), unit: 'days' })),
    source: `${src}; days since the oldest allowance figure was read on its provider's page`,
    read_at: readAt,
  };
}
