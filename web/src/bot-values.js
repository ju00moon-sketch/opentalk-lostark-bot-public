import { timingSafeEqual } from 'node:crypto';
import { isCustomTierArt } from '../../src/tier-art.js';

// The bot's loopback-only view of the website's numbers (README.md): the same
// efficiency the character page shows and the expected acquisition gold, reduced to what the commands print.
export const BOT_VALUES_PATH = '/internal/bot/character-values';
export const BOT_VALUE_PARTS = ['efficiency', 'valuation', 'spec'];
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const gold = value => (finite(value) && value >= 0 ? value : null);
const count = value => (Number.isSafeInteger(value) && value >= 0 ? value : 0);

export function isLoopbackAddress(address) { return typeof address === 'string' && LOOPBACK.has(address); }

// Configured token and presented header must be the same bytes; a missing configuration never matches.
export function botTokenMatches(configured, presented) {
  if (typeof configured !== 'string' || configured.length < 32 || typeof presented !== 'string') return false;
  const expected = Buffer.from(configured), actual = Buffer.from(presented);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// "efficiency,valuation" → Set; null when a part is unknown or repeated. Absent means the two original parts.
export function parseBotParts(value) {
  if (value === null || value === undefined) return new Set(['efficiency', 'valuation']);
  if (typeof value !== 'string' || !value) return null;
  const parts = value.split(',');
  if (parts.some(part => !BOT_VALUE_PARTS.includes(part)) || new Set(parts).size !== parts.length) return null;
  return new Set(parts);
}

function ok(entry) { return entry?.status === 'ok' && finite(entry.efficiency); }

export function summarizeBotEfficiency(efficiency) {
  const bracelet = efficiency?.bracelet, gem = efficiency?.gem;
  const effects = Array.isArray(gem?.effectEfficiencies) ? gem.effectEfficiencies
    .filter(effect => typeof effect?.name === 'string' && finite(effect.effect) && finite(effect.efficiency))
    .slice(0, 40)
    .map(effect => ({ name: effect.name.slice(0, 40), level: Number.isSafeInteger(effect.level) ? effect.level : null, effect: effect.effect, efficiency: effect.efficiency })) : [];
  return {
    bracelet: { status: ok(bracelet) ? 'ok' : 'unavailable', efficiency: ok(bracelet) ? bracelet.efficiency : null },
    gem: { status: ok(gem) ? 'ok' : 'unavailable', efficiency: ok(gem) ? gem.efficiency : null,
      optionEfficiency: ok(gem) && finite(gem.optionEfficiency) ? gem.optionEfficiency : null,
      pointEfficiency: ok(gem) && finite(gem.pointEfficiency) ? gem.pointEfficiency : null,
      effectEfficiencies: ok(gem) ? effects : [] },
  };
}

// /포펙: the character page's score, tier, best record and the two efficiencies, reduced to what the command prints.
export function summarizeBotSpec({ profile, efficiency, tier, record }) {
  const text = (value, max) => (typeof value === 'string' && value.length > 0 && value.length <= max ? value : null);
  const score = efficiency?.score, okScore = score?.status === 'ok' && finite(score.score);
  const tierOut = okScore && tier && typeof tier === 'object' && typeof tier.key === 'string' ? {
    key: tier.key, name: text(tier.name, 12), status: tier.status === 'ok' ? 'ok' : 'unavailable', basis: text(tier.basis, 12),
    percentile: finite(tier.percentile) ? tier.percentile : null, source: text(tier.source, 20), reason: text(tier.reason, 40),
    next: tier.next && typeof tier.next === 'object' && typeof tier.next.name === 'string' ? { name: text(tier.next.name, 12), percentile: finite(tier.next.percentile) ? tier.next.percentile : null } : null,
    reference: tier.reference && finite(tier.reference.score)
      ? { score: tier.reference.score, percentile: finite(tier.reference.percentile) ? tier.reference.percentile : null, name: text(tier.reference.name, 12) } : null,
    // Custom artwork (README.md): only the pictures change, the tier above is real.
    art: isCustomTierArt(tier.art) && typeof tier.art.name === 'string' ? { key: tier.art.key, name: text(tier.art.name, 12), label: text(tier.art.label, 20) } : null,
  } : null;
  const both = summarizeBotEfficiency(efficiency);
  return {
    status: okScore ? 'ok' : 'unavailable',
    profile: profile && typeof profile === 'object' ? {
      characterName: text(profile.characterName, 40), serverName: text(profile.serverName, 20), characterClass: text(profile.characterClass, 20),
      itemLevel: finite(profile.itemLevel) ? profile.itemLevel : null, combatPower: finite(profile.combatPower) ? profile.combatPower : null,
      title: text(profile.title, 40), guildName: text(profile.guildName, 40), characterImage: text(profile.characterImage, 300) } : null,
    score: okScore ? { score: score.score, role: score.role === 'support' ? 'support' : 'dealer', modelVersion: text(score.modelVersion, 30) } : null,
    omitted: okScore ? [] : (Array.isArray(score?.omitted) ? score.omitted.filter(line => typeof line === 'string').slice(0, 5).map(line => line.slice(0, 80)) : []),
    tier: tierOut,
    record: record && finite(record.score) && Number.isSafeInteger(record.recordedAt)
      ? { score: Math.round(record.score * 100) / 100, recordedAt: record.recordedAt, current: okScore && Math.abs(score.score - record.score) <= 1e-9 * Math.max(1, record.score) } : null,
    bracelet: both.bracelet,
    gem: { status: both.gem.status, efficiency: both.gem.efficiency },
  };
}

// characterValuation.expectations(name) (the same envelope as get(name, 'character'), bracelet and ark grid gems only)
// → { status, bracelet: { gold, record, reason }, gems: { gold, knownGold, items, known, reason } }.
export function summarizeBotValuation(result) {
  if (!result || typeof result !== 'object') return { status: 'unavailable' };
  if (result.status !== 'done') return { status: 'running' };
  const row = result.characters?.[0], value = row?.value;
  if (!value || typeof value !== 'object' || row.state !== 'done' || !value.components || typeof value.components !== 'object') return { status: 'unavailable' };
  const braceletGroup = value.components.bracelet, item = braceletGroup?.items?.[0];
  const bracelet = item?.status === 'ok'
    ? { gold: gold(item.expectedAcquisitionGold), record: Boolean(value.braceletDetails?.record), reason: null }
    : { gold: null, record: false,
      reason: typeof item?.reason === 'string' ? item.reason : braceletGroup && braceletGroup.items?.length === 0 ? 'no_bracelet' : 'unavailable' };
  const group = value.components.arkgridGems;
  const gems = group && typeof group === 'object'
    ? { gold: group.complete === true ? gold(group.expectedAcquisitionGold) : null, knownGold: gold(group.knownExpectedAcquisitionGold),
      items: count(group.counts?.items), known: count(group.counts?.known),
      reason: group.complete === true ? null : Array.isArray(group.items) && group.items.some(item => item?.reason === 'rate_limited') ? 'rate_limited' : 'partial' }
    : { gold: null, knownGold: null, items: 0, known: 0, reason: 'unavailable' };
  return { status: 'done', bracelet, gems };
}
