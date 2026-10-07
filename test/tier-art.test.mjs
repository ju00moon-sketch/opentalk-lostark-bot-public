import test from 'node:test';
import assert from 'node:assert/strict';
import { CUSTOM_TIER_ART, CUSTOM_TIER_ART_KEYS, customTierArtByKey, isCustomTierArt } from '../src/tier-art.js';
import { TIERS } from '../src/score-tier.js';

test('custom tier art keys never collide with the score tier keys and describe the shipped assets', () => {
  const tierKeys = new Set(TIERS.map(row => row.key));
  for (const entry of CUSTOM_TIER_ART) {
    assert.ok(!tierKeys.has(entry.key), `${entry.key} is a real tier key`);
    assert.match(entry.key, /^[a-z]{3,12}$/, 'the kakao card link only accepts short lower-case keys');
    assert.ok(entry.name.length <= 12 && entry.label.length <= 20);
    assert.ok(Array.isArray(entry.anchors) && entry.anchors.length > 0);
    assert.ok(Number.isInteger(entry.plate.width) && Number.isInteger(entry.plate.height));
  }
  assert.equal(new Set(CUSTOM_TIER_ART_KEYS).size, CUSTOM_TIER_ART.length);
  assert.deepEqual(CUSTOM_TIER_ART_KEYS, ['dream']);
  assert.deepEqual(customTierArtByKey('dream'), { key: 'dream', name: '합성원정대', label: '합성원정대 전용 티어', anchors: ['합성원정대'], plate: { width: 960, height: 384 } });
  assert.equal(customTierArtByKey('esther'), null); assert.equal(customTierArtByKey(undefined), null);
  assert.equal(isCustomTierArt({ key: 'dream' }), true);
  for (const value of [{ key: 'esther' }, { key: 'nope' }, 'dream', null, undefined, 3]) assert.equal(isCustomTierArt(value), false);
  assert.throws(() => { CUSTOM_TIER_ART[0].anchors.push('x'); });
});
