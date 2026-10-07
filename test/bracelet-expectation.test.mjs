import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateBraceletExpectation as calculate, BraceletExpectationInputError } from '../src/bracelet-expectation.js';
import { BRACELET_T4_DATA as data, BRACELET_T4_EFFECTS as effects } from '../src/bracelet-t4-data.js';

const close = (actual, expected, tolerance = 2e-12) => assert.ok(Math.abs(actual - expected) <= Math.max(1e-18, Math.abs(expected) * tolerance), `${actual} != ${expected}`);
const single = () => ({ rarity: 'relic', fixed: [{ id: 'combat.crit', value: 41 }, { id: 'combat.swiftness', value: 100 }], granted: [{ id: 'special.cooldownDamage', tier: 3 }] });
const main = () => ({ rarity: 'ancient', fixed: [{ id: 'combat.crit', value: 97 }, { id: 'combat.swiftness', value: 91 }],
  granted: [{ id: 'special.cooldownDamage', tier: 3 }, { id: 'base.mainStat', value: 11712 }, { id: 'special.critDamageDamage', tier: 1 }] });

test('one slot has geometric success over four grants and three optional tickets', () => {
  const result = calculate(single());
  const specialWeightTotal = 10 * 7 + 12 * (0.5 + 0.25 + 0.08333) + 11 * (1.0909 + 0.5455 + 0.1818);
  const p = 0.30 / 0.65 * 0.08333 / specialWeightTotal;
  close(result.initialGrantProbability, p);
  close(result.expectedIndependentInitialGrants, 1 / p);
  result.probabilityByRoll.forEach(({ roll, successProbability, expectedRollsPerBracelet }) => {
    close(successProbability, -Math.expm1(roll * Math.log1p(-p)));
    close(expectedRollsPerBracelet, -Math.expm1(roll * Math.log1p(-p)) / p);
  });
  assert.equal(result.normalRolls, 4);
  assert.equal(result.scenarios.length, 4);
  assert.equal(result.scenarios[3].totalRolls, 7);
});

test('two target locking matches an independent closed-form Markov derivation', () => {
  const input = single();
  input.granted = [{ id: 'base.mainStat', value: 6400 }, { id: 'base.vitality', value: 3000 }];
  const result = calculate(input);
  const a = 0.175, b = 0.175, total = 0.65;
  const pBoth = a / total * b / (total - a) + b / total * a / (total - b);
  const specials = effects.filter(effect => effect.category === 'special');
  const totalSpecialWeight = specials.reduce((s, effect) => s + effect.tierWeights.reduce((x, y) => x + y, 0), 0);
  const nuisance = specials.map(effect => 0.30 * effect.tierWeights.reduce((x, y) => x + y, 0) / totalSpecialWeight);
  const pOnlyA = nuisance.reduce((s, w) => s + a / total * w / (total - a) + w / total * a / (total - w), 0);
  const pOnlyB = nuisance.reduce((s, w) => s + b / total * w / (total - b) + w / total * b / (total - w), 0);
  const pNone = 1 - pBoth - pOnlyA - pOnlyB;
  close(result.initialGrantProbability, pBoth);
  for (const row of result.probabilityByRoll) {
    const stillOnly = (pOnly, q) => pOnly * Array.from({ length: row.roll }, (_, k) => pNone ** k * (1 - q) ** (row.roll - k - 1)).reduce((x, y) => x + y, 0);
    const failure = pNone ** row.roll + stillOnly(pOnlyA, b / (total - a)) + stillOnly(pOnlyB, a / (total - b));
    close(row.successProbability, 1 - failure);
  }
});

test('inclusive value thresholds use unequal first interval width correctly', () => {
  const first = single(); first.granted = [{ id: 'base.mainStat', value: 6400 }];
  const p = calculate(first).initialGrantProbability;
  first.granted[0].value = 6401;
  close(calculate(first).initialGrantProbability / p, 1 - 0.1 / 641);
  first.granted[0].value = 7041;
  close(calculate(first).initialGrantProbability / p, 0.9);
  first.granted[0].value = 12800;
  close(calculate(first).initialGrantProbability / p, 0.04 / 640);
});

test('special tier order supports lower-is-better cooldown effects', () => {
  const input = single(); input.granted = [{ id: 'special.immunity', tier: 1 }];
  const low = calculate(input);
  input.granted[0].tier = 3;
  const high = calculate(input);
  close(high.initialGrantProbability / low.initialGrantProbability, 0.1);
  assert.deepEqual(effects.find(x => x.id === 'special.immunity').tiers.ancient.map(x => x.values), [[80], [70], [60]]);
});

test('same numeric stat threshold is monotonic, not a newly sampled fixed effect', () => {
  const input = main(); const original = calculate(input);
  input.fixed[0].value = 120;
  assert.deepEqual(calculate(input), original);
  input.granted[1].value = 15361;
  const higher = calculate(input);
  assert.ok(higher.initialGrantProbability < original.initialGrantProbability);
  assert.ok(higher.successProbability < original.successProbability);
});

test('three-target order does not change initial or lock strategy probabilities', () => {
  const input = main(); const original = calculate(input);
  input.fixed.reverse(); input.granted.reverse();
  const reversed = calculate(input);
  close(original.initialGrantProbability, reversed.initialGrantProbability);
  original.scenarios.forEach((row, i) => close(row.successProbability, reversed.scenarios[i].successProbability));
  assert.ok(original.successProbability > 1 - (1 - original.initialGrantProbability) ** 4);
});

test('independent start gold, early stop, and ticket consumption are separate', () => {
  const input = main(); input.startingBraceletGold = 1200; input.reconversionTickets = 2;
  const result = calculate(input);
  assert.equal(result.totalRolls, 6);
  close(result.expectedStartingBraceletGold, 1200 / result.successProbability);
  close(result.expectedRollsUntilSuccess, result.expectedRollsPerBracelet / result.successProbability);
  close(result.expectedReconversionTicketsPerBracelet,
    2 - result.probabilityByRoll[3].successProbability - result.probabilityByRoll[4].successProbability);
  close(result.expectedReconversionTicketsUntilSuccess, result.expectedReconversionTicketsPerBracelet / result.successProbability);
  assert.equal(result.silverCost, null);
  assert.equal(calculate(main()).expectedStartingBraceletGold, null);
  input.startingBraceletGold = 0;
  assert.equal(calculate(input).expectedStartingBraceletGold, 0);
});

test('range data is complete, contiguous and totals one; public catalog is immutable', () => {
  assert.equal(effects.length, 41);
  assert.equal(new Set(effects.map(x => x.id)).size, 41);
  assert.equal(effects.filter(x => x.fixedAllowed).length, 18);
  for (const effect of effects) {
    if (!effect.ranges) continue;
    for (const ranges of Object.values(effect.ranges)) {
      assert.equal(ranges.reduce((n, row) => n + row.weight, 0), 100);
      ranges.slice(1).forEach((row, i) => assert.equal(row.min, ranges[i].max + 1));
    }
  }
  assert.equal(data.categoryLimits.special, 5);
  assert.throws(() => { effects[0].ranges.relic[0].weight = 0; }, TypeError);
});

test('input is not mutated and malformed inputs never silently relax the target', () => {
  const input = main(); const copy = structuredClone(input);
  calculate(input); assert.deepEqual(input, copy);
  const invalid = [null, [], {}, { ...input, rarity: 'T3' }, { ...input, fixed: [] },
    { ...input, granted: [{ id: 'base.mainStat', value: 9600 }] },
    { ...input, granted: [{ id: 'combat.crit', value: 100 }, { id: 'base.mainStat', value: 9600 }] },
    { ...input, fixed: [{ id: 'special.cooldownDamage', tier: 2 }] },
    { ...input, granted: [{ id: 'combat.specialization', value: 100 }, { id: 'base.mainStat', value: 9600 }] },
    { ...input, fixed: [{ id: 'base.mainStat', value: '9600' }] },
    { ...input, fixed: [{ id: 'base.mainStat', value: 16001 }] },
    { ...input, fixed: [{ id: 'special.immunity', tier: 0 }] },
    { ...input, fixed: [{ id: 'base.mainStat', value: 9600, tier: 1 }] },
    { ...input, reconversionTickets: 4 }, { ...input, reconversionTickets: 1.5 },
    { ...input, startingBraceletGold: Infinity }, { ...input, startingBraceletGold: -1 },
    { ...input, startingBraceletGold: '1000' }, { ...input, unsupported: true }];
  for (const value of invalid) assert.throws(() => calculate(value), error => error instanceof BraceletExpectationInputError && error.code === 'invalid_bracelet_expectation');
});

test('all supported slot layouts stay finite, conserve bounds, and improve with tickets', () => {
  for (const rarity of ['relic', 'ancient']) for (const fixedCount of [1, 2]) for (const { count } of data.grantedCounts[rarity]) {
    const input = { rarity, fixed: [{ id: 'combat.crit', value: 65 }, { id: 'combat.swiftness', value: 65 }].slice(0, fixedCount),
      granted: [{ id: 'special.cooldownDamage', tier: 3 }, { id: 'special.critRateDamage', tier: 3 }, { id: 'special.critDamageDamage', tier: 3 }].slice(0, count) };
    const result = calculate(input);
    let last = 0;
    for (const row of result.probabilityByRoll) {
      assert.ok(row.successProbability > last && row.successProbability <= 1);
      assert.ok(row.expectedRollsPerBracelet >= 1 && row.expectedRollsPerBracelet <= row.roll);
      last = row.successProbability;
    }
    for (const scenario of result.scenarios) assert.ok(Number.isFinite(scenario.expectedStartingBracelets));
  }
});
