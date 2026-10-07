import cuts from './data/score-tier-cuts.json' with { type: 'json' };

// Ten score tiers shared by the bot and the website. A tier is normally assigned from a
// percentile (top N% of a population, smaller is better); the fixed score minimums are the
// fallback when no percentile is available. Both tables live in data/score-tier-cuts.json.
const finite = value => typeof value === 'number' && Number.isFinite(value);

export const CUTS_VERSION = cuts.version;
export const TIERS = Object.freeze(cuts.tiers.map(row => Object.freeze({ ...row })));
const byKey = new Map(TIERS.map(row => [row.key, row]));

export function describeTier(key) {
  const row = byKey.get(key);
  return row ? { key: row.key, name: row.name, rank: row.rank } : null;
}

function nextOf(index) {
  const next = TIERS[index + 1];
  return next ? { key: next.key, name: next.name, rank: next.rank, percentile: next.percentCut, minimum: next.fixedMinimum } : null;
}

// percent = top N% (0 < percent <= 100). Boundaries belong to the higher tier (<=).
// The returned percentile is the value that was judged, unrounded: 0.001% is a real esther rank and
// the website rejects 0. Rounding for display happens in the front end.
export function tierFromPercentile(percent) {
  if (!finite(percent) || percent <= 0 || percent > 100) return null;
  let index = 0;
  for (let i = TIERS.length - 1; i >= 1; i--) {
    if (percent <= TIERS[i].percentCut) { index = i; break; }
  }
  const row = TIERS[index];
  return { key: row.key, name: row.name, rank: row.rank, percentile: percent, next: nextOf(index) };
}

// Fixed cut fallback; keeps the progress fields the website already renders.
export function tierFromScore(score) {
  if (!finite(score) || score < 0) return null;
  const index = TIERS.findLastIndex(row => score >= row.fixedMinimum);
  const row = TIERS[index], next = TIERS[index + 1];
  return { key: row.key, name: row.name, rank: row.rank, basis: 'fixed', minimum: row.fixedMinimum,
    nextName: next?.name ?? null, nextMinimum: next?.fixedMinimum ?? null,
    remaining: next ? Number((next.fixedMinimum - score).toFixed(2)) : 0,
    progress: next ? Math.floor((score - row.fixedMinimum) / (next.fixedMinimum - row.fixedMinimum) * 100) : 100,
    next: nextOf(index) };
}
