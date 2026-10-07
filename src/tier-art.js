// Custom tier artwork shared by the bot and the website (README.md).
// An entry replaces only the pictures (emblem, name plate, badge, card) for its anchors and every
// character on the same roster; the tier itself, the rank, the percentile and the wording stay real.
// Keys must never collide with the score tier keys in data/score-tier-cuts.json (checked by test).
export const CUSTOM_TIER_ART = Object.freeze([
  Object.freeze({ key: 'dream', name: '합성원정대', label: '합성원정대 전용 티어', anchors: Object.freeze(['합성원정대']), plate: Object.freeze({ width: 960, height: 384 }) }),
]);

export const CUSTOM_TIER_ART_KEYS = CUSTOM_TIER_ART.map(row => row.key);

export function customTierArtByKey(key) {
  return CUSTOM_TIER_ART.find(row => row.key === key) ?? null;
}

export function isCustomTierArt(value) {
  return Boolean(value) && typeof value === 'object' && CUSTOM_TIER_ART_KEYS.includes(value.key);
}
