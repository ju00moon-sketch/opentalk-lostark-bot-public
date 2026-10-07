import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateNormalHoning, evaluateAdvancedHoning, getHoningValuationRecipe } from '../src/honing-valuation.js';
import { HONING_STAGES, HONING_ADVANCED, HONING_MODEL } from '../src/data/honing-valuation.js';

const near = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const target = extra => ({ id: 'honing:완갑', kind: 'honing', status: 'ok', targetKey: 'a'.repeat(64),
  slot: '완갑', tier: 4, grade: '영웅', itemName: '운명의 전율 완갑', itemLevel: null,
  refinement: 1, advancedRefinement: null, advancedRefinementStatus: 'unobserved', ...extra });

test('a fixed half chance sums survival until the sixth guaranteed attempt', () => {
  const result = evaluateNormalHoning({ successBps: 5000, failBonusBps: 0 });
  assert.equal(result.status, 'ok'); near(result.expectedAttempts, 1.96875);
  assert.equal(result.maximumAttempts, 6);
  near(result.successProbability, 1);
  assert.equal(evaluateNormalHoning({ successBps: 10000, failBonusBps: 0 }).expectedAttempts, 1);
});

test('normal honing includes failure probability growth, a ten-stack cap and finite pity', () => {
  const result = evaluateNormalHoning({ successBps: 50, failBonusBps: 5 });
  assert.equal(result.status, 'ok');
  assert.ok(result.expectedAttempts > 50 && result.expectedAttempts < 110);
  assert.equal(result.steps[10].successProbability, .01);
  assert.equal(result.steps[11].successProbability, .01);
  assert.equal(result.steps.at(-1).successProbability, 1);
  assert.equal(result.steps.at(-1).guaranteed, true);
  near(result.steps.reduce((s, r) => s + r.reachProbability * r.successProbability, 0), 1);
});

test('invalid probabilities and unknown rules never become zero-cost calculations', () => {
  for (const row of [null, {}, { successBps: 0, failBonusBps: 0 }, { successBps: -1, failBonusBps: 1 },
    { successBps: 10001, failBonusBps: 1 }, { successBps: 300, failBonusBps: NaN }]) {
    assert.equal(evaluateNormalHoning(row).status, 'unavailable');
  }
});

test('numeric facts distinguish once-per-stage growth from per-attempt costs', () => {
  assert.equal(Object.values(HONING_STAGES).reduce((n, rows) => n + rows.length, 0), 125);
  const first = HONING_STAGES.vambrace[0], last = HONING_STAGES.vambrace[24];
  assert.deepEqual([first.growthShards, first.growthSilver, first.shards, first.gold], [145000, 1450000, 14500, 5200]);
  assert.deepEqual([last.growthShards, last.growthSilver, last.shards, last.gold], [607000, 6070000, 38470, 13160]);
  assert.equal(HONING_MODEL.baseline.refinement, 18);
  assert.equal(HONING_MODEL.baseline.advancedRefinement, 20);
  assert.ok(Object.isFrozen(HONING_STAGES.vambrace[0]));
});

// Independent forward probability propagation for one advanced level. This does
// not call the production transition or use its tables.
function forwardOneAdvancedLevel() {
  let states = new Map([['0,0,0,0', { exp: 0, orbs: 0, enhanced: false, free: false, p: 1 }]]);
  let attempts = 0, paid = 0, terminal = 0;
  for (let turn = 0; turn < 12 && states.size; turn++) {
    const next = new Map();
    for (const state of states.values()) {
      attempts += state.p; if (!state.free) paid += state.p;
      const effects = state.orbs < 6 ? [[1,1,0,false,false,false,0]] : state.enhanced
        ? [[.2,7,0,false,false,false,0],[.2,5,0,false,false,false,0],[.2,1,80,true,false,false,0],[.2,1,30,false,false,true,0],[.2,1,0,false,false,false,2]]
        : [[.125,5,0,false,false,false,0],[.25,3,0,false,false,false,0],[.125,1,30,true,false,false,0],[.25,1,10,false,false,true,0],[.125,1,0,true,true,false,0],[.125,1,0,false,false,false,1]];
      for (const [prob, mult, plus, refill, enhanced, free, advance] of effects) for (const [exp, chance] of [[10,.8],[20,.15],[40,.05]]) {
        const p = state.p * prob * chance;
        if (advance || state.exp + exp * mult + plus >= 100) { terminal += p; continue; }
        const row = { exp: state.exp + exp * mult + plus, orbs: state.orbs < 6 ? state.orbs + 2 : refill ? 6 : 0, enhanced, free, p };
        const key = `${row.exp},${row.orbs},${+enhanced},${+free}`;
        if (next.has(key)) next.get(key).p += p; else next.set(key, row);
      }
    }
    states = next;
  }
  near(terminal, 1); return { attempts, paid };
}

test('advanced 20 to 21 matches independent forward enumeration including free attempts', () => {
  const oracle = forwardOneAdvancedLevel();
  const actual = evaluateAdvancedHoning({ equipmentType: 'weapon', startStage: 20, targetStage: 21 });
  assert.equal(actual.status, 'ok'); near(actual.expectedAttempts, oracle.attempts);
  near(actual.segments[0].expectedPaidAttempts, oracle.paid);
  assert.ok(actual.segments[0].expectedPaidAttempts < actual.expectedAttempts);
  near(actual.fixedGold, oracle.paid * 3000);
});

test('advanced segment boundaries reset progress and allow additive expectations', () => {
  const whole = evaluateAdvancedHoning({ equipmentType: 'armor', startStage: 20, targetStage: 40 });
  const a = evaluateAdvancedHoning({ equipmentType: 'armor', startStage: 20, targetStage: 30 });
  const b = evaluateAdvancedHoning({ equipmentType: 'armor', startStage: 30, targetStage: 40 });
  assert.equal(whole.status, 'ok'); near(whole.expectedAttempts, a.expectedAttempts + b.expectedAttempts);
  near(whole.fixedGold, a.fixedGold + b.fixedGold);
  assert.equal(whole.segments.length, 2);
  for (const type of Object.values(HONING_ADVANCED)) for (const segment of type) {
    near(segment.outcomes.reduce((s, r) => s + r.probability, 0), 1);
    near(segment.blessings.reduce((s, r) => s + r.probability, 0), 1);
  }
});

test('vambrace recipe charges growth shards once and attempt shards by expectation', () => {
  const input = target(), before = JSON.stringify(input), recipe = getHoningValuationRecipe(input);
  assert.equal(recipe.status, 'ok'); assert.equal(recipe.targetKey, input.targetKey);
  const attempts = evaluateNormalHoning(HONING_STAGES.vambrace[0]).expectedAttempts;
  near(recipe.fixedGold, 5200 * attempts);
  near(recipe.materials['운명의 파편'], 145000 + 14500 * attempts);
  near(recipe.excludedSilver, 1450000 + 80000 * attempts);
  const bag = recipe.quotes.find(row => row.name === '운명의 파편 주머니(대)');
  near(recipe.requirements.find(row => row.quoteKey === bag.quoteKey).quantity, recipe.materials['운명의 파편'] / 3000);
  assert.ok(recipe.assumptions.some(s => s.includes('숨결')));
  assert.equal(JSON.stringify(input), before);
});

test('baseline and below-baseline gear is explicit while malformed or unknown gear is unavailable', () => {
  const baseline = target({ id: 'honing:무기', slot: '무기', itemName: '운명의 업화 검', grade: '고대', itemLevel: 1700,
    refinement: 18, advancedRefinement: 20, advancedRefinementStatus: 'observed' });
  const result = getHoningValuationRecipe(baseline);
  assert.equal(result.status, 'ok'); assert.equal(result.fixedGold, 0); assert.deepEqual(result.requirements, []);
  assert.equal(result.basisStatus, 'at_or_below_baseline');
  for (const input of [null, {}, target({ refinement: 26 }), target({ refinement: 1.2 }), target({ tier: 3 }),
    target({ grade: '알수없음' }), target({ targetKey: 'bad' }), target({ itemName: '알수없는 완갑' }),
    { ...baseline, itemLevel: 1700.5, advancedRefinement: null, advancedRefinementStatus: 'unobserved' }]) {
    const actual = getHoningValuationRecipe(input);
    assert.equal(actual.status, 'unavailable'); assert.equal(actual.fixedGold, null);
  }
});

test('ordinary growth facts use the starting-level index and preserve once-only costs', () => {
  assert.equal(HONING_STAGES.t4Weapon[18].growthShards, 85000);
  assert.equal(HONING_STAGES.t4Armor[18].growthShards, 51000);
  assert.equal(HONING_STAGES.serkaWeapon[11].growthShards, 57000);
  assert.equal(HONING_STAGES.serkaArmor[24].growthShards, 91000);
});

test('an observed item level can recover missing advanced refinement without inventing a default', () => {
  const input = target({ slot: '무기', grade: '고대', itemName: '운명의 업화 검', refinement: 19,
    itemLevel: 1705, advancedRefinement: null, advancedRefinementStatus: 'unobserved' });
  const recipe = getHoningValuationRecipe(input);
  assert.equal(recipe.status, 'ok');
  assert.ok(recipe.assumptions.some(text => text.includes('역산')));
  near(recipe.materials['운명의 파편'], 85000 + 13700 * evaluateNormalHoning(HONING_STAGES.t4Weapon[18]).expectedAttempts);
  assert.equal(getHoningValuationRecipe({ ...input, itemLevel: 1730 }).status, 'unavailable');
  assert.equal(getHoningValuationRecipe({ ...input, advancedRefinement: 21, advancedRefinementStatus: 'observed' }).status, 'unavailable');
});

test('advanced stages above 30 are priced from the published 30-40 segment for weapons and armor', () => {
  for (const [slot, equipmentType] of [['무기', 'weapon'], ['투구', 'armor']]) {
    assert.equal(HONING_ADVANCED[equipmentType].map(rule => `${rule.from}-${rule.to}`).join(','), '0-10,10-20,20-30,30-40');
    const input = target({ slot, grade: '고대', itemName: '운명의 업화 장비', refinement: 20,
      itemLevel: 1690 + 37, advancedRefinement: 37, advancedRefinementStatus: 'observed' });
    const recipe = getHoningValuationRecipe(input);
    assert.equal(recipe.status, 'ok');
    const advanced = recipe.steps.find(step => step.kind === 'advanced');
    assert.deepEqual([advanced.from, advanced.to], [20, 37]);
    assert.deepEqual(advanced.segments.map(row => [row.from, row.to]), [[20, 30], [30, 37]]);
    // The last segment is entered, so its own per-attempt materials are part of the cost.
    for (const material of Object.keys(HONING_ADVANCED[equipmentType][3].materials)) assert.ok(recipe.materials[material] > 0);
    assert.ok(recipe.fixedGold > getHoningValuationRecipe({ ...input, itemLevel: 1690 + 30, advancedRefinement: 30 }).fixedGold);
  }
});

test('Serka gear includes pre-transfer refinement and advanced refinement costs', () => {
  const recipe = getHoningValuationRecipe(target({ slot: '무기', grade: '고대', itemName: '운명의 전율 검',
    refinement: 12, itemLevel: 1735 }));
  assert.equal(recipe.status, 'ok');
  const normal = recipe.steps.filter(row => row.kind === 'normal');
  assert.deepEqual(normal.map(row => [row.family, row.from, row.to]), [['t4',18,19],['t4',19,20],['serka',11,12]]);
  assert.ok(recipe.steps.some(row => row.kind === 'advanced' && row.to === 40));
  assert.ok(recipe.steps.some(row => row.kind === 'transfer'));
  assert.equal(recipe.quotes.find(row => row.name === '상급 아비도스 융화 재료').grade, '영웅');
});

test('the public advanced helper rejects pre-baseline segments whose legacy costs are not supported', () => {
  assert.equal(evaluateAdvancedHoning({ equipmentType: 'weapon', startStage: 0, targetStage: 10 }).status, 'unavailable');
  for (const input of [null, [], 7, 'weapon', { equipmentType: 'weapon', startStage: 20, targetStage: NaN }]) {
    assert.equal(evaluateAdvancedHoning(input).status, 'unavailable');
  }
  for (const equipmentType of ['toString', 'constructor', '__proto__', 'vambrace']) {
    assert.equal(evaluateAdvancedHoning({ equipmentType, startStage: 20, targetStage: 21 }).status, 'unavailable');
  }
});

test('weapon tempering is charged once at each newly opened advanced segment', () => {
  const gear = extra => target({ slot: '무기', grade: '고대', itemName: '운명의 업화 검', refinement: 18,
    itemLevel: 1700, advancedRefinement: 20, advancedRefinementStatus: 'observed', ...extra });
  for (const [level, shards, silver] of [[21,115000,2300000],[30,115000,2300000],[31,345000,4830000],[40,345000,4830000]]) {
    const recipe = getHoningValuationRecipe(gear({ itemLevel: 1680 + level, advancedRefinement: level }));
    const attempts = evaluateAdvancedHoning({ equipmentType: 'weapon', startStage: 20, targetStage: level });
    assert.equal(recipe.status, 'ok');
    near(recipe.materials['운명의 파편'], attempts.materials['운명의 파편'] + shards);
    near(recipe.excludedSilver, attempts.excludedSilver + silver);
    near(recipe.fixedGold, attempts.fixedGold);
    assert.equal(recipe.steps.filter(row => row.kind === 'tempering').length, level <= 30 ? 1 : 2);
  }
});

test('armor tempering uses its independently observed fixed fees', () => {
  for (const [level, shards, silver] of [[30,70000,1850000],[40,210000,3885000]]) {
    const input = target({ slot: '장갑', grade: '고대', itemName: '운명의 업화 장갑', refinement: 18,
      itemLevel: 1680 + level, advancedRefinement: level, advancedRefinementStatus: 'observed' });
    const recipe = getHoningValuationRecipe(input);
    const attempts = evaluateAdvancedHoning({ equipmentType: 'armor', startStage: 20, targetStage: level });
    assert.equal(recipe.status, 'ok');
    near(recipe.materials['운명의 파편'], attempts.materials['운명의 파편'] + shards);
    near(recipe.excludedSilver, attempts.excludedSilver + silver);
  }
});
