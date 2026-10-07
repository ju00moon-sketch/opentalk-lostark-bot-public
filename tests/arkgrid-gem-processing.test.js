import test from 'node:test';
import assert from 'node:assert/strict';
import * as processing from '../src/arkgrid-gem-processing.js';
import { GEM_PROCESSING_OUTCOMES, GEM_PROCESSING_STARTS } from '../src/data/arkgrid-gem-processing.js';
import {
  createGemProcessingState, getInitialGemEffectPairs, getGemProcessingCandidates,
  calculateWeightedOfferMarginals, getGemProcessingMarginals,
  applyGemProcessingOutcome, applyGemProcessingOffer, refreshGemProcessingOffer,
} from '../src/arkgrid-gem-processing.js';

const close = (actual, expected, tolerance = 1e-11) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
function initial() { return createGemProcessingState({ grade: '영웅', subtype: '안정', effects: ['공격력', '추가 피해'] }).state; }
function progressed(changes = {}) { return { ...initial(), processedCount: 3, remainingAttempts: 6, ...changes }; }

test('the published 27 candidate weights total 100% and remain immutable', () => {
  assert.equal(GEM_PROCESSING_OUTCOMES.length, 27);
  assert.equal(new Set(GEM_PROCESSING_OUTCOMES.map(x => x.id)).size, 27);
  assert.equal(GEM_PROCESSING_OUTCOMES.reduce((sum, x) => sum + x.weight, 0), 10000);
  assert.deepEqual(GEM_PROCESSING_OUTCOMES.filter(x => x.axis === 0).map(x => x.weight), [1165, 440, 175, 45, 300]);
  assert.ok(Object.isFrozen(GEM_PROCESSING_OUTCOMES));
  assert.ok(GEM_PROCESSING_OUTCOMES.every(Object.isFrozen));
  assert.equal(GEM_PROCESSING_STARTS.영웅.attempts, 9);
  assert.equal(GEM_PROCESSING_STARTS.영웅.baseGold, 900);
  assert.equal(GEM_PROCESSING_STARTS.희귀.baseGold, 900);
  assert.equal(GEM_PROCESSING_STARTS.고급.attempts, 5);
});

test('initial unordered effect pairs are six equal possibilities without duplicates', () => {
  for (const subtype of ['안정', '침식', '견고', '왜곡', '불변', '붕괴']) {
    const result = getInitialGemEffectPairs(subtype);
    assert.equal(result.status, 'ok');
    assert.equal(result.pairs.length, 6);
    assert.equal(new Set(result.pairs.map(x => [...x.effects].sort().join('|'))).size, 6);
    for (const pair of result.pairs) { close(pair.probability, 1 / 6); assert.notEqual(...pair.effects); }
  }
  assert.equal(getInitialGemEffectPairs('다른 젬').status, 'unavailable');
});

test('only verified initial facts are created; unknown counts and malformed states fail', () => {
  assert.deepEqual(initial().points, [1, 1, 1, 1]);
  assert.equal(initial().remainingAttempts, 9);
  assert.equal(initial().rerollsRemaining, 2);
  const uncommon = createGemProcessingState({ grade: '고급', subtype: '안정', effects: ['공격력', '추가 피해'] });
  assert.equal(uncommon.status, 'ok');
  assert.equal(uncommon.state.remainingAttempts, 5);
  assert.equal(uncommon.state.rerollsRemaining, 0);
  assert.equal(uncommon.baseGoldStatus, 'unavailable');
  assert.equal(createGemProcessingState({ grade: '영웅', subtype: '안정', effects: ['공격력', '공격력'] }).status, 'unavailable');
  for (const bad of [null, {}, progressed({ points: [0, 1, 1, 1] }), progressed({ remainingAttempts: -1 }), progressed({ costModifier: 0.5 }), progressed({ effects: ['공격력', '보스 피해'] }), progressed({ rerollsRemaining: 99 })]) {
    assert.equal(getGemProcessingCandidates(bad).status, 'unavailable');
  }
});

test('axis limits, last attempt exclusions, and cost bounds are applied before drawing', () => {
  const first = getGemProcessingCandidates(initial()).candidates.map(x => x.id);
  assert.ok(first.includes('axis0.plus4'));
  assert.ok(!first.includes('axis0.minus1'));
  const later = getGemProcessingCandidates(progressed({ points: [5, 4, 3, 2], costModifier: 1 })).candidates.map(x => x.id);
  assert.ok(!later.includes('axis0.plus1'));
  assert.ok(later.includes('axis0.minus1'));
  assert.ok(!later.includes('axis1.plus2'));
  assert.ok(!later.includes('axis2.plus3'));
  assert.ok(!later.includes('axis3.plus4'));
  assert.ok(!later.includes('cost.plus100'));
  assert.ok(later.includes('cost.minus100'));
  const last = getGemProcessingCandidates(progressed({ processedCount: 8, remainingAttempts: 1 })).candidates.map(x => x.id);
  assert.ok(last.every(id => !id.startsWith('cost.') && !id.startsWith('reroll.')));
  const ended = getGemProcessingCandidates(progressed({ processedCount: 9, remainingAttempts: 0 }));
  assert.equal(ended.status, 'complete');
  assert.deepEqual(ended.candidates, []);
});

test('weighted four-draw marginals match an independent ordered enumeration', () => {
  const input = [1, 2, 3, 7, 13].map((weight, i) => ({ id: String(i), weight }));
  const inclusion = new Array(5).fill(0);
  function enumerate(chosen, probability) {
    if (chosen.length === 4) { for (const i of chosen) inclusion[i] += probability; return; }
    const available = input.map((x, i) => ({ ...x, i })).filter(x => !chosen.includes(x.i));
    const sum = available.reduce((total, x) => total + x.weight, 0);
    for (const x of available) enumerate([...chosen, x.i], probability * x.weight / sum);
  }
  enumerate([], 1);
  const actual = calculateWeightedOfferMarginals(input);
  assert.equal(actual.status, 'ok');
  for (let i = 0; i < 5; i++) { close(actual.outcomes[i].inclusionProbability, inclusion[i]); close(actual.outcomes[i].probability, inclusion[i] / 4); }
  close(actual.outcomes.reduce((sum, x) => sum + x.probability, 0), 1);
  assert.ok(Math.abs(actual.outcomes[4].probability - 13 / 26) > .1);
});

test('exactly four offered outcomes have equal application probability regardless of weights', () => {
  const result = calculateWeightedOfferMarginals([1, 2, 10, 100].map((weight, i) => ({ id: String(i), weight })));
  for (const item of result.outcomes) { close(item.inclusionProbability, 1); close(item.probability, .25); }
  for (const bad of [[], [{ id: 'a', weight: 0 }], Array.from({ length: 28 }, (_, i) => ({ id: String(i), weight: 1 })), [1, 2, 3, 4].map(weight => ({ id: 'same', weight }))]) {
    assert.equal(calculateWeightedOfferMarginals(bad).status, 'unavailable');
  }
});

test('all candidate probability remains represented after every transition is implemented', () => {
  const result = getGemProcessingMarginals(initial());
  assert.equal(result.status, 'ok');
  close(result.outcomes.reduce((sum, x) => sum + x.probability, 0), 1);
  close(result.supportedProbability + result.unavailableProbability, 1);
  close(result.unavailableProbability, 0);
  const unknown = result.outcomes.filter(x => x.transitionStatus === 'unavailable');
  assert.deepEqual(unknown, []);
  const last = getGemProcessingMarginals(progressed({ processedCount: 8, remainingAttempts: 1 }));
  assert.deepEqual(last.outcomes.filter(x => x.transitionStatus === 'unavailable'), []);
});

test('confirmed transitions consume exactly one attempt without mutating input', () => {
  const state = progressed({ points: [2, 1, 1, 1] });
  const before = JSON.stringify(state);
  const plus = applyGemProcessingOutcome(state, 'axis1.plus4');
  assert.equal(plus.status, 'ok');
  assert.deepEqual(plus.state.points, [2, 5, 1, 1]);
  assert.equal(plus.state.remainingAttempts, 5);
  assert.equal(plus.state.processedCount, 4);
  assert.deepEqual(applyGemProcessingOutcome(state, 'axis0.minus1').state.points, [1, 1, 1, 1]);
  assert.equal(applyGemProcessingOutcome(state, 'reroll.plus2').state.rerollsRemaining, 4);
  assert.deepEqual(applyGemProcessingOutcome(state, 'unchanged').state.points, state.points);
  assert.equal(JSON.stringify(state), before);
  assert.equal(applyGemProcessingOutcome(state, 'axis1.minus1').reason, 'outcome_ineligible');
});

test('a four-offer processing step flattens effect branches without losing their probability', () => {
  const state = progressed({ points: [1, 1, 5, 3] });
  const result = applyGemProcessingOffer(state, ['axis0.plus1', 'axis1.plus4', 'effect0.change', 'cost.plus100']);
  assert.equal(result.status, 'ok');
  close(result.outcomes.reduce((sum, x) => sum + x.probability, 0), 1);
  assert.equal(result.outcomes.length, 5);
  assert.deepEqual(result.outcomes.filter(x => x.id === 'effect0.change').map(x => x.probability), [.125, .125]);
  assert.equal(applyGemProcessingOffer(state, ['axis0.plus1', 'axis0.plus1', 'axis1.plus1', 'axis2.plus1']).status, 'unavailable');
});

test('cost changes add to the modifier and charge the old rate for the current attempt', () => {
  const raised = applyGemProcessingOutcome(initial(), 'cost.plus100');
  assert.equal(raised.status, 'ok');
  assert.equal(raised.state.costModifier, 1);
  assert.equal(raised.cost.gold, 900);
  assert.equal(raised.nextCost.gold, 1800);
  assert.equal(applyGemProcessingOutcome(raised.state, 'cost.plus100').reason, 'outcome_ineligible');
  const restored = applyGemProcessingOutcome(raised.state, 'cost.minus100');
  assert.equal(restored.state.costModifier, 0);
  assert.equal(restored.cost.gold, 1800);
  assert.equal(restored.nextCost.gold, 900);
  const free = applyGemProcessingOutcome(restored.state, 'cost.minus100');
  assert.equal(free.state.costModifier, -1);
  assert.equal(free.cost.gold, 900);
  assert.equal(free.nextCost.gold, 0);
  assert.equal(applyGemProcessingOutcome(free.state, 'cost.minus100').reason, 'outcome_ineligible');
  const normal = applyGemProcessingOutcome(free.state, 'cost.plus100');
  assert.equal(normal.state.costModifier, 0);
  assert.equal(normal.cost.gold, 0);
  assert.equal(normal.nextCost.gold, 900);
});

test('unverified base cost is not inferred from another grade and completed gems cannot be charged', () => {
  assert.equal(typeof processing.getGemProcessingCost, 'function');
  const { getGemProcessingCost } = processing;
  const uncommon = createGemProcessingState({ grade: '고급', subtype: '침식', effects: ['공격력', '추가 피해'] }).state;
  assert.equal(getGemProcessingCost(uncommon).reason, 'base_processing_gold_unverified');
  const rare = createGemProcessingState({ grade: '희귀', subtype: '왜곡', effects: ['공격력', '보스 피해'] }).state;
  assert.equal(getGemProcessingCost(rare).gold, 900);
  const ended = { ...initial(), processedCount: 9, remainingAttempts: 0 };
  assert.equal(getGemProcessingCost(ended).status, 'complete');
  assert.equal(getGemProcessingCost(ended).gold, null);
});

test('other options refresh is separate from reset and cannot be used before first processing', () => {
  assert.equal(refreshGemProcessingOffer(initial()).reason, 'refresh_before_first_processing');
  const state = progressed();
  const result = refreshGemProcessingOffer(state);
  assert.equal(result.status, 'ok');
  assert.equal(result.state.rerollsRemaining, 1);
  assert.equal(result.state.remainingAttempts, state.remainingAttempts);
  assert.equal(result.state.processedCount, state.processedCount);
  assert.deepEqual(result.state.points, state.points);
  assert.equal(refreshGemProcessingOffer({ ...state, rerollsRemaining: 0 }).reason, 'refresh_unavailable');
});

test('sparse arrays cannot silently remove probability or effect constraints', () => {
  const effects = ['공격력', '추가 피해']; delete effects[1];
  assert.equal(createGemProcessingState({ grade: '영웅', subtype: '안정', effects }).status, 'unavailable');
  const points = [1, 2, 3, 4]; delete points[2];
  assert.equal(getGemProcessingCandidates(progressed({ points })).status, 'unavailable');
  const weights = [1, 2, 3, 4].map((weight, i) => ({ id: String(i), weight })); delete weights[2];
  assert.equal(calculateWeightedOfferMarginals(weights).status, 'unavailable');
  const offer = ['axis0.plus1', 'axis1.plus1', 'axis2.plus1', 'axis3.plus1']; delete offer[2];
  assert.equal(applyGemProcessingOffer(initial(), offer).status, 'unavailable');
});

test('effect identity changes exclude both occupied effects and split evenly between the other two', () => {
  assert.equal(typeof processing.getGemEffectChangeChoices, 'function');
  const result = processing.getGemEffectChangeChoices(progressed({ points: [1, 1, 5, 3] }), 0);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.choices, [{ effect: '아군 피해 강화', probability: .5 }, { effect: '낙인력', probability: .5 }]);
  assert.equal(result.levelTransition, 'preserved-by-model-interpretation');
  assert.equal(processing.getGemEffectChangeChoices(initial(), 2).status, 'unavailable');
  assert.equal(processing.getGemEffectChangeChoices(initial(), '0').status, 'unavailable');
});

test('effect-change branches preserve both levels and consume only one attempt', () => {
  const state = progressed({ points: [1, 1, 5, 3] });
  const before = JSON.stringify(state);
  const result = applyGemProcessingOutcome(state, 'effect0.change');
  assert.equal(result.status, 'ok');
  assert.equal(result.state, null);
  assert.equal(result.branches.length, 2);
  for (const branch of result.branches) {
    close(branch.probability, .5);
    assert.deepEqual(branch.state.points, [1, 1, 5, 3]);
    assert.equal(branch.state.effects[1], '추가 피해');
    assert.equal(branch.state.remainingAttempts, 5);
    assert.equal(branch.state.processedCount, 4);
  }
  assert.deepEqual(result.branches.map(x => x.state.effects[0]), ['아군 피해 강화', '낙인력']);
  const second = applyGemProcessingOutcome(state, 'effect1.change');
  assert.equal(second.status, 'ok');
  for (const branch of second.branches) {
    assert.deepEqual(branch.state.points, [1, 1, 5, 3]);
    assert.equal(branch.state.effects[0], '공격력');
    assert.ok(['아군 피해 강화', '낙인력'].includes(branch.state.effects[1]));
  }
  assert.equal(JSON.stringify(state), before);
  assert.equal(result.cost.gold, 900);
  assert.ok(result.assumptions.length > 0);
  assert.equal(applyGemProcessingOutcome(state, 'unchanged').branches.length, 1);
});
