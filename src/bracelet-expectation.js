import { BRACELET_T4_DATA, BRACELET_T4_EFFECTS } from './bracelet-t4-data.js';
import { BRACELET_T3_DATA, BRACELET_T3_EFFECTS } from './bracelet-t3-data.js';

export class BraceletExpectationInputError extends TypeError {
  constructor(field) {
    super(`Invalid bracelet expectation input: ${field}`);
    this.name = 'BraceletExpectationInputError';
    this.code = 'invalid_bracelet_expectation';
    this.field = field;
  }
}

const categories = ['base', 'combat', 'special'];
const sum = values => values.reduce((a, b) => a + b, 0);
function model(tier, DATA, EFFECTS) {
const weights = EFFECTS.map(effect => effect.tierWeights ? sum(effect.tierWeights) : effect.weight);
const categoryTotals = categories.map(category => sum(weights.filter((_, i) => EFFECTS[i].category === category)));
const pool = EFFECTS.map((effect, index) => ({
  index, category: categories.indexOf(effect.category),
  // Each published subtable has rounding at its own precision; normalize its displayed weights.
  mass: DATA.categoryWeights[effect.category] / 100 * weights[index] / categoryTotals[categories.indexOf(effect.category)],
}));
const byId = new Map(EFFECTS.map((effect, i) => [effect.id, i]));
return {tier,DATA,EFFECTS,pool,byId};
}
const models=new Map([[3,model(3,BRACELET_T3_DATA,BRACELET_T3_EFFECTS)],[4,model(4,BRACELET_T4_DATA,BRACELET_T4_EFFECTS)]]);
const fail = field => { throw new BraceletExpectationInputError(field); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function effectInput(model, value, rarity, fixed, field) {
  const {EFFECTS,byId}=model;
  if (!record(value) || !byId.has(value.id)) fail(field);
  const index = byId.get(value.id);
  const effect = EFFECTS[index];
  const valueKey = effect.category === 'special' ? 'tier' : 'value';
  if (Object.keys(value).some(key => key !== 'id' && key !== valueKey)
    || Object.keys(value).length !== 2 || (fixed && !effect.fixedAllowed)) fail(field);
  if (valueKey === 'tier') {
    if (!Number.isInteger(value.tier) || value.tier < 1 || value.tier > 3) fail(field);
    return { index, tail: sum(effect.tierWeights.slice(value.tier - 1)) / sum(effect.tierWeights) };
  }
  const ranges = effect.ranges[rarity];
  if (!Number.isInteger(value.value) || value.value < ranges[0].min || value.value > ranges.at(-1).max) fail(field);
  // Bounds are inclusive integers. The first main-stat/vitality interval has one extra value.
  const tail = sum(ranges.map(range => range.weight / 100
    * Math.max(0, range.max - Math.max(range.min, value.value) + 1) / (range.max - range.min + 1)));
  return { index, tail };
}

function validate(input) {
  if (!record(input)) fail('input');
  if (Object.keys(input).some(key => !['itemTier','rarity', 'fixed', 'granted', 'startingBraceletGold', 'reconversionTickets'].includes(key))) fail('input');
  const model=models.get(input.itemTier===undefined?4:input.itemTier);
  if(!model)fail('itemTier');
  const {DATA,EFFECTS}=model;
  if (input.rarity !== 'relic' && input.rarity !== 'ancient') fail('rarity');
  if (!Array.isArray(input.fixed) || ![1, 2].includes(input.fixed.length)) fail('fixed');
  const counts = DATA.grantedCounts[input.rarity].map(row => row.count);
  if (!Array.isArray(input.granted) || !counts.includes(input.granted.length)) fail('granted');
  const fixed = input.fixed.map((effect, i) => effectInput(model,effect, input.rarity, true, `fixed[${i}]`));
  const granted = input.granted.map((effect, i) => effectInput(model,effect, input.rarity, false, `granted[${i}]`));
  const all = [...fixed, ...granted];
  if (new Set(all.map(effect => effect.index)).size !== all.length) fail('duplicate_effect');
  for (const category of categories) {
    if (all.filter(effect => EFFECTS[effect.index].category === category).length > DATA.categoryLimits[category]) fail('category_limit');
  }
  const price = input.startingBraceletGold ?? null;
  if (price !== null && (typeof price !== 'number' || !Number.isFinite(price) || price < 0 || price > 1e12)) fail('startingBraceletGold');
  const tickets = input.reconversionTickets ?? 0;
  if (!Number.isInteger(tickets) || tickets < 0 || tickets > DATA.maxReconversionTickets) fail('reconversionTickets');
  return { model,fixed, granted, price, tickets, rarity: input.rarity };
}

// State is the subset of target effects already meeting their thresholds and locked.
// Every other slot is redrawn together. Non-target effects and below-threshold targets
// still exclude their entire family during this draw, then disappear before the next draw.
function transition(model,fixed, granted, lockedMask) {
  const {DATA,EFFECTS,pool}=model;
  const result = new Float64Array(1 << granted.length);
  const used = new Uint8Array(EFFECTS.length);
  const counts = [0, 0, 0];
  const targetByIndex = new Int8Array(EFFECTS.length).fill(-1);
  granted.forEach((target, i) => { targetByIndex[target.index] = i; });
  let lockedCount = 0;
  for (const effect of fixed) { used[effect.index] = 1; counts[pool[effect.index].category]++; }
  granted.forEach((effect, i) => {
    if (lockedMask & (1 << i)) {
      used[effect.index] = 1;
      counts[pool[effect.index].category]++;
      lockedCount++;
    }
  });
  const limits = categories.map(category => DATA.categoryLimits[category]);
  const selectedTargets = [];
  function finish(index, mask, chance) {
    if (index === selectedTargets.length) { result[mask] += chance; return; }
    const target = selectedTargets[index];
    finish(index + 1, mask | (1 << target), chance * granted[target].tail);
    if (granted[target].tail < 1) finish(index + 1, mask, chance * (1 - granted[target].tail));
  }
  function draw(remaining, chance) {
    if (!remaining) { finish(0, lockedMask, chance); return; }
    let denominator = 0;
    for (const effect of pool) if (!used[effect.index] && counts[effect.category] < limits[effect.category]) denominator += effect.mass;
    for (const effect of pool) {
      if (used[effect.index] || counts[effect.category] >= limits[effect.category]) continue;
      used[effect.index] = 1;
      counts[effect.category]++;
      const target = targetByIndex[effect.index];
      if (target >= 0) selectedTargets.push(target);
      draw(remaining - 1, chance * effect.mass / denominator);
      if (target >= 0) selectedTargets.pop();
      counts[effect.category]--;
      used[effect.index] = 0;
    }
  }
  draw(granted.length - lockedCount, 1);
  return result;
}

/** Conditional on buying the same fixed effects and granted-slot count; no external I/O. */
export function calculateBraceletExpectation(input) {
  const { model,fixed, granted, price, tickets, rarity } = validate(input);
  const {DATA}=model;
  const states = 1 << granted.length;
  const complete = states - 1;
  const transitions = Array.from({ length: states }, (_, mask) => transition(model,fixed, granted, mask));
  let distribution = new Float64Array(states);
  distribution[0] = 1;
  let expectedRolls = 0;
  let expectedTickets = 0;
  const probabilityByRoll = [];
  for (let roll = 1; roll <= DATA.normalRolls + DATA.maxReconversionTickets; roll++) {
    const stillTrying = sum(distribution.slice(0, complete));
    expectedRolls += stillTrying;
    if (roll > DATA.normalRolls) expectedTickets += stillTrying;
    const next = new Float64Array(states);
    for (let before = 0; before < states; before++) {
      for (let after = before; after < states; after++) next[after] += distribution[before] * transitions[before][after];
    }
    distribution = next;
    probabilityByRoll.push({ roll, successProbability: distribution[complete],
      expectedRollsPerBracelet: expectedRolls, expectedReconversionTicketsPerBracelet: expectedTickets });
  }
  const initialGrantProbability = probabilityByRoll[0].successProbability;
  const scenarios = Array.from({ length: DATA.maxReconversionTickets + 1 }, (_, count) => {
    const row = probabilityByRoll[DATA.normalRolls + count - 1];
    const expectedStartingBracelets = 1 / row.successProbability;
    return {
      reconversionTickets: count, totalRolls: row.roll, successProbability: row.successProbability,
      expectedStartingBracelets, startingBraceletGold: price,
      expectedStartingBraceletGold: price === null ? null : price * expectedStartingBracelets,
      expectedRollsPerBracelet: row.expectedRollsPerBracelet,
      expectedRollsUntilSuccess: row.expectedRollsPerBracelet * expectedStartingBracelets,
      expectedReconversionTicketsPerBracelet: row.expectedReconversionTicketsPerBracelet,
      expectedReconversionTicketsUntilSuccess: row.expectedReconversionTicketsPerBracelet * expectedStartingBracelets,
      silverCost: null,
    };
  });
  return {
    status: 'ok', tier:model.tier,dataVersion: DATA.version, scope: 'same-fixed-and-slot-count',
    strategy: 'lock-satisfied-targets', rarity, fixedCount: fixed.length, grantedCount: granted.length,
    normalRolls: DATA.normalRolls, initialGrantProbability,
    expectedIndependentInitialGrants: 1 / initialGrantProbability,
    ...scenarios[tickets], probabilityByRoll, scenarios, sources: { ...DATA.sources },
    assumptions: ['published-weights-normalized', 'same-fixed-and-slot-count', 'no-upgrade',
      'lock-satisfied-targets-before-each-reroll', 'redraw-all-unlocked-effects',
      'stop-on-success', 'independent-identical-starting-bracelets',
      'starting-price-excludes-pheons-silver-and-tickets', 'silver-cost-unverified',...(model.tier===3?['t3-no-reconversion-tickets']:[])],
  };
}
