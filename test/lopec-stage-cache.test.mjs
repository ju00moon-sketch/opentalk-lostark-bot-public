import test from 'node:test';
import assert from 'node:assert/strict';
import { createStageCostMemo, withStageCostCache } from '../src/lopec-stage-cache.js';

function input() {
  return { tier: 't4', equipmentType: 'armor', currentStage: 20,
    currentArtisanEnergy: 0, currentFailedAttempts: 0,
    priceSnapshot: { capturedAt: '2026-09-15', entries: { fusion: { bundlePrice: 30, bundleCount: 1 } } },
    actionSelector: { additiveCount: 0, additiveCounts: {}, bookItemName: null } };
}
function result(gold = 100) {
  return Object.freeze({ expectedCost: Object.freeze({ gold, attempts: 3,
    materials: Object.freeze({ fusion: 2 }) }), evaluatedStates: Object.freeze([]) });
}

test('identical full inputs share only the frozen expected cost', () => {
  const memo = createStageCostMemo();
  let calls = 0;
  const solve = () => { calls++; return result(); };
  const original = memo.run(solve, input());
  const hit = memo.run(solve, input());
  assert.equal(calls, 1);
  assert.equal(hit.expectedCost, original.expectedCost);
  assert.deepEqual(Object.keys(hit), ['expectedCost']);
  assert.throws(() => { hit.expectedCost.materials.fusion = 9; }, TypeError);
});

test('prices, quantities, phase inputs and every action selector field remain distinct', () => {
  const memo = createStageCostMemo();
  let calls = 0;
  const solve = () => result(++calls);
  const variants = [
    (v) => { v.priceSnapshot.entries.fusion.bundlePrice++; },
    (v) => { v.priceSnapshot.entries.fusion.bundleCount++; },
    (v) => { v.priceSnapshot.capturedAt = '2026-09-16'; },
    (v) => { v.actionSelector.additiveCount++; },
    (v) => { v.actionSelector.additiveCounts['lava-breath'] = 2; },
    (v) => { v.actionSelector.bookItemName = '재봉술'; },
    (v) => { v.currentStage++; },
    (v) => { v.currentArtisanEnergy = 0.1; },
    (v) => { v.currentFailedAttempts++; },
    (v) => { v.tier = 'serka'; },
    (v) => { v.equipmentType = 'weapon'; },
    (v) => { v.additionalInput = true; },
  ];
  memo.run(solve, input());
  for (const change of variants) {
    const value = input(); change(value);
    memo.run(solve, value);
  }
  assert.equal(calls, variants.length + 1);
  assert.equal(memo.run(solve, input()).expectedCost.gold, 1);
  memo.reset();
  assert.equal(memo.run(solve, input()).expectedCost.gold, variants.length + 2);
});

test('non-JSON values, ambiguous objects and sparse arrays bypass reuse', () => {
  const circular = {}; circular.self = circular;
  const symbolKey = { [Symbol('input')]: 1 };
  const hidden = Object.defineProperty({}, 'value', { value: 1 });
  const cases = [undefined, NaN, Infinity, -0, 1n, Symbol('value'), () => 1,
    circular, symbolKey, hidden, new Date(), new Map(), [, 1], Object.create({ inherited: 1 })];
  for (const extra of cases) {
    const memo = createStageCostMemo();
    let calls = 0;
    const solve = () => { calls++; return result(); };
    const value = { ...input(), extra };
    memo.run(solve, value); memo.run(solve, value);
    assert.equal(calls, 2);
  }
});

test('key construction does not execute getters or toJSON hooks', () => {
  for (const hook of ['getter', 'toJSON']) {
    let invoked = 0;
    const value = input();
    if (hook === 'getter') Object.defineProperty(value, 'extra', { enumerable: true, get() { invoked++; return 1; } });
    else value.toJSON = () => { invoked++; return {}; };
    const memo = createStageCostMemo();
    let calls = 0;
    const solve = () => { calls++; return result(); };
    memo.run(solve, value); memo.run(solve, value);
    assert.equal(invoked, 0);
    assert.equal(calls, 2);
  }
});

test('failed calculations and mutable costs are never cached', () => {
  const memo = createStageCostMemo();
  let calls = 0;
  const solve = () => { if (++calls === 1) throw new Error('missing price'); return result(); };
  assert.throws(() => memo.run(solve, input()), /missing price/);
  memo.run(solve, input()); memo.run(solve, input());
  assert.equal(calls, 2);
  for (const value of [null, { expectedCost: { gold: 1, materials: {} } },
    { expectedCost: Object.freeze({ gold: 1, materials: {} }) }]) {
    const fresh = createStageCostMemo();
    let count = 0;
    const mutable = () => { count++; return value; };
    fresh.run(mutable, input()); fresh.run(mutable, input());
    assert.equal(count, 2);
  }
});

test('retained costs are bounded and a new evaluation starts empty', () => {
  const memo = createStageCostMemo();
  let calls = 0;
  const solve = () => { calls++; return result(); };
  for (let index = 0; index < 514; index++) memo.run(solve, { index });
  memo.run(solve, { index: 0 });
  assert.equal(calls, 514);
  memo.run(solve, { index: 513 });
  assert.equal(calls, 515);
  memo.reset(); memo.run(solve, { index: 0 });
  assert.equal(calls, 516);
});

test('an unknown or modified upstream runtime remains unchanged', () => {
  for (const code of ['', '/* specup-subset-v1 */ const MODULES={};', 'throw new Error("upstream changed");']) {
    assert.equal(withStageCostCache(code), code);
  }
});
