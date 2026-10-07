import { GuildError } from './guild-store.js';
import { normalizeCharacter } from './character-profile.js';
import { getLopecScore } from '../../src/lopec.js';
import { CUTS_VERSION, tierFromPercentile } from '../../src/score-tier.js';
import { CUSTOM_TIER_ART } from '../../src/tier-art.js';

const TIER_CACHE_MS = 5 * 60 * 1000;
const TIER_CACHE_MAX = 500;
// Custom tier art targets (an anchor's roster) are read once and kept for six hours; a failed read
// keeps the previous set and is retried after ten minutes so the official API is not called per character.
const ART_CACHE_MS = 6 * 60 * 60 * 1000;
const ART_RETRY_MS = 10 * 60 * 1000;
// Relative gap between the lopec record score and our current score beyond which the lopec rank is not shown.
const RECORD_DRIFT = 0.03;
// lopec rounds its top percent to two decimals, so the very top ranks read 0.00%. A zero next to a
// real rank is therefore "below 0.005%", which every tier cut treats as the top tier.
const TOP_RANK_PERCENT = 0.001;
const finite = value => typeof value === 'number' && Number.isFinite(value);

// Reuse the official armory read, cache, request budget, and cancellation owned by
// the spec service. Website calculations do not contact the bot companion.
// The tier percentile comes from the lopec DB page for now (see README.md);
// when it is missing or slow the fixed score cut carried by the score object is used instead.
export function createCharacterEfficiencyService({ readDetails, readLopecScore = getLopecScore, now = Date.now,
  tierTimeoutMs = 4000, setTimer = setTimeout, clearTimer = clearTimeout, scoreRecords = null,
  readRoster = null, artCacheMs = ART_CACHE_MS, artRetryMs = ART_RETRY_MS } = {}) {
  const attempts = new Map();
  const tierCache = new Map();
  const tierPending = new Map();
  const artTargets = new Map();
  const artPending = new Map();
  let closed = false;
  function allow(ip) {
    const timestamp = now();
    for (const [key, entry] of attempts) if (entry.until <= timestamp) attempts.delete(key);
    let entry = attempts.get(ip);
    if (!entry) {
      if (attempts.size >= 10000) return false;
      entry = { count: 0, until: timestamp + 60000 };
      attempts.set(ip, entry);
    }
    return ++entry.count <= 20;
  }
  function fixedTier(score, reason, art = null) {
    const fixed = score?.status === 'ok' && score.tier && typeof score.tier.key === 'string' ? score.tier : null;
    return { status: 'unavailable', key: fixed?.key ?? null, name: fixed?.name ?? null, rank: fixed?.rank ?? null,
      basis: 'fixed', percentile: null, population: null, source: '고정 점수 구간', sampledAt: null,
      next: fixed?.next ? { key: fixed.next.key, name: fixed.next.name, percentile: fixed.next.percentile ?? null } : null,
      reason: fixed ? reason : 'score_unavailable', reference: null, cutsVersion: CUTS_VERSION, art };
  }
  function withTimeout(promise) {
    return new Promise((resolve, reject) => {
      const timer = setTimer(() => reject(Object.assign(new Error('lopec timeout'), { code: 'timeout' })), tierTimeoutMs);
      Promise.resolve(promise).then(value => { clearTimer(timer); resolve(value); }, error => { clearTimer(timer); reject(error); });
    });
  }
  async function lookupPercentile(name) {
    const key = name.toLowerCase();
    const hit = tierCache.get(key);
    if (hit && now() - hit.at < TIER_CACHE_MS) return hit.value;
    let pending = tierPending.get(key);
    if (!pending) {
      pending = (async () => {
        try {
          const lopec = await withTimeout(readLopecScore(name));
          if (!lopec) return { reason: 'lopec_unknown_character' };
          // Only a number or a numeric string counts: Number(null), Number('') and Number(false) are all 0, and a
          // missing percentile must fall back to the fixed cuts instead of reading as the rounded top 0%.
          const reportedNumber = value => (typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN);
          const rank = reportedNumber(lopec.totalRank), reported = reportedNumber(lopec.totalPercent);
          const percent = reported === 0 && Number.isInteger(rank) && rank >= 1 ? TOP_RANK_PERCENT : reported;
          if (!finite(percent) || percent <= 0 || percent > 100) return { reason: 'lopec_unavailable' };
          // The lopec rank belongs to the character's best recorded score; keep it so the caller can
          // tell whether that record still describes the currently equipped state.
          const record = Number(lopec.dbScore);
          const value = { percent, recordScore: finite(record) && record > 0 ? record : null, sampledAt: new Date(now()).toISOString() };
          tierCache.set(key, { at: now(), value });
          while (tierCache.size > TIER_CACHE_MAX) tierCache.delete(tierCache.keys().next().value);
          return value;
        } catch {
          return { reason: 'lopec_unavailable' };
        } finally { tierPending.delete(key); }
      })();
      tierPending.set(key, pending);
    }
    return pending;
  }
  const nameKey = value => normalizeCharacter(value)?.toLowerCase() ?? null;
  const anchorKeys = entry => new Set(entry.anchors.map(nameKey).filter(Boolean));
  // Lower-cased names that use this entry's artwork: the anchors plus everyone on an anchor's roster.
  // One roster read per anchor per six hours, shared while pending; a failure keeps the last good set.
  function artTargetsOf(entry) {
    const anchors = anchorKeys(entry);
    if (typeof readRoster !== 'function') return anchors;
    const state = artTargets.get(entry.key), at = now();
    if (state?.names && at - state.at < artCacheMs) return state.names;
    if (state?.retryAt && at < state.retryAt) return state.names ?? anchors;
    let pending = artPending.get(entry.key);
    if (!pending) {
      pending = (async () => {
        try {
          const names = new Set(anchors);
          for (const anchor of entry.anchors) {
            const data = await withTimeout(readRoster(anchor));
            if (!Array.isArray(data?.roster?.characters)) throw new Error('roster unavailable');
            for (const row of data.roster.characters) { const key = nameKey(row?.characterName); if (key) names.add(key); }
          }
          if (!closed) artTargets.set(entry.key, { names, at: now(), retryAt: 0 });
          return names;
        } catch {
          const previous = artTargets.get(entry.key);
          if (!closed) artTargets.set(entry.key, { names: previous?.names ?? null, at: previous?.at ?? 0, retryAt: now() + artRetryMs });
          return previous?.names ?? anchors;
        } finally { artPending.delete(entry.key); }
      })();
      artPending.set(entry.key, pending);
    }
    return pending;
  }
  // { key, name, label } of the custom artwork this character shows, or null. Never throws.
  async function lookupArt(name) {
    const key = name.toLowerCase();
    for (const entry of CUSTOM_TIER_ART) {
      try {
        if (anchorKeys(entry).has(key) || (await artTargetsOf(entry)).has(key)) return { key: entry.key, name: entry.name, label: entry.label };
      } catch { /* the artwork is optional; the tier itself is unaffected */ }
    }
    return null;
  }
  // score = details.efficiency.score (fixed tier inside). Never throws; failures fall back to the fixed cut.
  async function resolveTier(value, score) {
    const name = normalizeCharacter(value);
    if (!name || closed) return fixedTier(score, 'score_unavailable');
    if (score?.status !== 'ok' || !finite(score.score)) return fixedTier(score, 'score_unavailable', await lookupArt(name));
    const [found, art] = await Promise.all([lookupPercentile(name), lookupArt(name)]);
    if (closed || found.reason) return fixedTier(score, found.reason || 'lopec_unavailable', art);
    const tier = tierFromPercentile(found.percent);
    if (!tier) return fixedTier(score, 'lopec_unavailable', art);
    // A rank earned by a much higher (or lower) recorded score does not describe the equipment being
    // scored now, e.g. gems taken off. Fall back to the fixed cut and keep the record as a reference.
    if (found.recordScore !== null && Math.abs(found.recordScore - score.score) / found.recordScore > RECORD_DRIFT) {
      return { ...fixedTier(score, 'lopec_record_mismatch', art), reference: { source: '로펙 DB', score: Math.round(found.recordScore * 100) / 100,
        percentile: tier.percentile, key: tier.key, name: tier.name, sampledAt: found.sampledAt } };
    }
    return { status: 'ok', key: tier.key, name: tier.name, rank: tier.rank, basis: 'lopec', percentile: tier.percentile,
      population: null, source: '로펙 DB', sampledAt: found.sampledAt,
      next: tier.next ? { key: tier.next.key, name: tier.next.name, percentile: tier.next.percentile } : null,
      reason: null, reference: null, cutsVersion: CUTS_VERSION, art };
  }
  // Best recorded 환산 점수 for the character; null when nothing is stored or the store is unavailable.
  function readScoreRecord(name, score) {
    if (!scoreRecords) return null;
    try {
      const record = scoreRecords.get(name);
      if (!record) return null;
      const current = score?.status === 'ok' && finite(score.score) && Math.abs(score.score - record.score) <= 1e-9 * Math.max(1, record.score);
      return { score: Math.round(record.score * 100) / 100, role: record.role, modelVersion: record.modelVersion, recordedAt: record.recordedAt, current };
    } catch { return null; }
  }
  async function get(value) {
    const name = normalizeCharacter(value);
    if (!name) throw new GuildError(400, 'invalid_request');
    if (closed || typeof readDetails !== 'function') throw new GuildError(503, 'efficiency_unavailable');
    const details = await readDetails(name);
    if (closed || !details?.efficiency || details.efficiency.source !== 'official-api' ||
        normalizeCharacter(details.efficiency.characterName)?.toLowerCase() !== name.toLowerCase()) {
      throw new GuildError(502, 'efficiency_unavailable');
    }
    const tier = await resolveTier(name, details.efficiency.score);
    if (closed) throw new GuildError(502, 'efficiency_unavailable');
    return { ...details.efficiency, tier, scoreRecord: readScoreRecord(name, details.efficiency.score) };
  }
  return { allow, get, resolveTier, close() { closed = true; attempts.clear(); tierCache.clear(); tierPending.clear(); artTargets.clear(); artPending.clear(); } };
}
