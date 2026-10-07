import test from 'node:test';
import assert from 'node:assert/strict';
import { TIERS, CUTS_VERSION, tierFromPercentile, tierFromScore, describeTier } from '../src/score-tier.js';
import { analyzeNativeSpecScore, classifyNativeSpecTier } from '../src/native-spec-score.js';

const names = TIERS.map(row => row.name);

test('ten tiers in order with a shared version', () => {
  assert.deepEqual(names, ['아이언', '브론즈', '실버', '골드', '플래티넘', '다이아몬드', '마스터', '그랜드마스터', '챌린저', '에스더']);
  assert.deepEqual(TIERS.map(row => row.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.match(CUTS_VERSION, /^\d{4}-\d{2}-\d{2}\.\d+$/);
  for (let i = 2; i < TIERS.length; i++) assert.ok(TIERS[i].percentCut < TIERS[i - 1].percentCut, `${TIERS[i].key} cut is tighter`);
  for (let i = 1; i < TIERS.length; i++) assert.ok(TIERS[i].fixedMinimum > TIERS[i - 1].fixedMinimum, `${TIERS[i].key} minimum is higher`);
  assert.equal(TIERS[0].percentCut, null);
  assert.deepEqual(describeTier('master'), { key: 'master', name: '마스터', rank: 7 });
  assert.equal(describeTier('legend'), null);
  assert.throws(() => { TIERS[0].name = 'x'; }, TypeError);
});

test('percentile boundaries belong to the higher tier', () => {
  const cases = [[0.05, '에스더'], [0.1, '에스더'], [0.11, '챌린저'], [0.5, '챌린저'], [0.51, '그랜드마스터'], [1.5, '그랜드마스터'],
    [1.51, '마스터'], [5, '마스터'], [5.01, '다이아몬드'], [12, '다이아몬드'], [12.01, '플래티넘'], [25, '플래티넘'],
    [25.01, '골드'], [45, '골드'], [45.01, '실버'], [70, '실버'], [70.01, '브론즈'], [90, '브론즈'], [90.01, '아이언'], [100, '아이언']];
  for (const [percent, name] of cases) assert.equal(tierFromPercentile(percent).name, name, `${percent}%`);
  assert.deepEqual(tierFromPercentile(6.92), { key: 'diamond', name: '다이아몬드', rank: 6, percentile: 6.92,
    next: { key: 'master', name: '마스터', rank: 7, percentile: 5, minimum: 5600 } });
  assert.equal(tierFromPercentile(0.05).next, null);
  // The API keeps the value it judged; rounding is a display concern (0.001% is a real esther rank, not 0).
  assert.equal(tierFromPercentile(1.006).percentile, 1.006);
  assert.deepEqual(tierFromPercentile(0.001), { key: 'esther', name: '에스더', rank: 10, percentile: 0.001, next: null });
  assert.equal(tierFromPercentile(0.004).percentile, 0.004);
  for (const value of [0, -1, 100.01, NaN, Infinity, '5', null, undefined]) assert.equal(tierFromPercentile(value), null);
});

test('fixed score cuts keep the progress fields and the old names map to the new table', () => {
  assert.equal(tierFromScore(0).name, '아이언');
  assert.equal(tierFromScore(799.99).name, '아이언');
  assert.equal(tierFromScore(800).name, '브론즈');
  assert.equal(tierFromScore(4300).name, '다이아몬드');
  assert.equal(tierFromScore(5599.99).name, '다이아몬드');
  assert.equal(tierFromScore(5600).name, '마스터');
  assert.equal(tierFromScore(7400).name, '그랜드마스터');
  assert.equal(tierFromScore(8000).name, '챌린저');
  assert.equal(tierFromScore(8800).name, '에스더');
  const tier = tierFromScore(5115.78);
  assert.equal(tier.basis, 'fixed');
  assert.equal(tier.minimum, 4300);
  assert.equal(tier.nextName, '마스터');
  assert.equal(tier.nextMinimum, 5600);
  assert.equal(tier.remaining, 484.22);
  assert.equal(tier.progress, 62);
  assert.equal(tier.next.key, 'master');
  const top = tierFromScore(9000);
  assert.equal(top.nextName, null); assert.equal(top.remaining, 0); assert.equal(top.progress, 100); assert.equal(top.next, null);
  for (const value of [-0.01, NaN, Infinity, '5000', null]) assert.equal(tierFromScore(value), null);
  assert.deepEqual(classifyNativeSpecTier(5115.78), tier);
  assert.equal(typeof analyzeNativeSpecScore, 'function');
});
