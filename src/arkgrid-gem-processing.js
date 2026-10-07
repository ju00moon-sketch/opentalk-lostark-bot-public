import {
  GEM_PROCESSING_MODEL, GEM_PROCESSING_SUBTYPES,
  GEM_PROCESSING_STARTS, GEM_PROCESSING_OUTCOMES,
} from './data/arkgrid-gem-processing.js';

const own = (object, key) => typeof key === 'string' && Object.hasOwn(object, key);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const unavailable = reason => ({ status: 'unavailable', reason, state: null });
const effectPairValid = (subtype, effects) => own(GEM_PROCESSING_SUBTYPES, subtype)
  && Array.isArray(effects) && effects.length === 2 && effects[0] !== effects[1]
  && Array.from(effects).every(effect => GEM_PROCESSING_SUBTYPES[subtype].effects.includes(effect));

function normalizeState(input) {
  if (!input || typeof input !== 'object' || !own(GEM_PROCESSING_STARTS, input.grade)) return null;
  const start = GEM_PROCESSING_STARTS[input.grade];
  if (start.attempts === null || input.totalAttempts !== start.attempts
    || !integer(input.processedCount, 0, start.attempts)
    || !integer(input.remainingAttempts, 0, start.attempts)
    || input.processedCount + input.remainingAttempts !== start.attempts
    || !integer(input.rerollsRemaining, 0, start.rerolls + 2 * input.processedCount)
    || !integer(input.costModifier, -1, 1)
    || !Array.isArray(input.points) || input.points.length !== 4
    || !Array.from(input.points).every(point => integer(point, 1, 5))
    || !effectPairValid(input.subtype, input.effects)) return null;
  if (input.processedCount === 0 && (input.points.some(point => point !== 1)
    || input.costModifier !== 0 || input.rerollsRemaining !== start.rerolls)) return null;
  return {
    grade: input.grade, subtype: input.subtype,
    points: [...input.points], effects: [...input.effects],
    totalAttempts: input.totalAttempts, processedCount: input.processedCount,
    remainingAttempts: input.remainingAttempts,
    rerollsRemaining: input.rerollsRemaining, costModifier: input.costModifier,
  };
}

export function createGemProcessingState(input) {
  if (!input || typeof input !== 'object' || !own(GEM_PROCESSING_STARTS, input.grade)
    || !effectPairValid(input.subtype, input.effects)) return unavailable('invalid_initial_state');
  const start = GEM_PROCESSING_STARTS[input.grade];
  if (start.attempts === null) return unavailable('starting_attempts_unverified');
  return {
    status: 'ok', baseGold: start.baseGold,
    baseGoldStatus: start.baseGold === null ? 'unavailable' : 'verified',
    state: {
      grade: input.grade, subtype: input.subtype, points: [1, 1, 1, 1], effects: [...input.effects],
      totalAttempts: start.attempts, processedCount: 0, remainingAttempts: start.attempts,
      rerollsRemaining: start.rerolls, costModifier: 0,
    },
  };
}

export function getInitialGemEffectPairs(subtype) {
  if (!own(GEM_PROCESSING_SUBTYPES, subtype)) return unavailable('unknown_gem_subtype');
  const effects = GEM_PROCESSING_SUBTYPES[subtype].effects;
  const pairs = [];
  for (let a = 0; a < effects.length; a++) {
    for (let b = a + 1; b < effects.length; b++) pairs.push({ effects: [effects[a], effects[b]], probability: 1 / 6 });
  }
  return { status: 'ok', pairs };
}

export function getGemEffectChangeChoices(input, effectIndex) {
  const state = normalizeState(input);
  if (!state || !integer(effectIndex, 0, 1)) return unavailable('invalid_effect_change');
  if (state.remainingAttempts === 0) return unavailable('outcome_ineligible');
  const effects = GEM_PROCESSING_SUBTYPES[state.subtype].effects.filter(effect => !state.effects.includes(effect));
  return {
    status: 'ok', effectIndex, levelTransition: GEM_PROCESSING_MODEL.effectLevelRule,
    assumptions: GEM_PROCESSING_MODEL.assumptions,
    choices: effects.map(effect => ({ effect, probability: 1 / effects.length })),
  };
}

function eligible(state, outcome) {
  if (state.remainingAttempts === 0) return false;
  if (outcome.kind === 'axis') {
    const value = state.points[outcome.axis] + outcome.delta;
    return value >= 1 && value <= 5;
  }
  if (outcome.kind === 'cost') {
    return state.remainingAttempts > 1 && state.costModifier !== outcome.delta;
  }
  if (outcome.kind === 'reroll') return state.remainingAttempts > 1;
  return true;
}

export function getGemProcessingCandidates(input) {
  const state = normalizeState(input);
  if (!state) return unavailable('invalid_processing_state');
  const candidates = GEM_PROCESSING_OUTCOMES.filter(outcome => eligible(state, outcome));
  return {
    status: state.remainingAttempts === 0 ? 'complete' : 'ok',
    candidates, totalWeight: candidates.reduce((sum, outcome) => sum + outcome.weight, 0),
  };
}

// Sum probabilities over unordered selected subsets. Each subset's probability
// already includes every possible draw order. Weights are never treated as the
// final processing probabilities: one of the four offered outcomes is uniform.
export function calculateWeightedOfferMarginals(input) {
  const count = GEM_PROCESSING_MODEL.offerCount;
  if (!Array.isArray(input) || input.length < count || input.length > 27
    || Array.from(input).some(item => !item || typeof item.id !== 'string' || !item.id || item.id.length > 80 || !integer(item.weight, 1, 10000))
    || new Set(input.map(item => item.id)).size !== input.length) return unavailable('invalid_candidate_weights');
  const totalWeight = input.reduce((sum, item) => sum + item.weight, 0);
  let subsets = new Map([[0, { probability: 1, selectedWeight: 0 }]]);
  for (let draw = 0; draw < count; draw++) {
    const next = new Map();
    for (const [mask, selected] of subsets) {
      const denominator = totalWeight - selected.selectedWeight;
      for (let index = 0; index < input.length; index++) {
        const bit = 2 ** index;
        if (mask & bit) continue;
        const nextMask = mask | bit;
        const probability = selected.probability * input[index].weight / denominator;
        const previous = next.get(nextMask);
        if (previous) previous.probability += probability;
        else next.set(nextMask, { probability, selectedWeight: selected.selectedWeight + input[index].weight });
      }
    }
    subsets = next;
  }
  const inclusion = new Array(input.length).fill(0);
  let totalOfferProbability = 0;
  for (const [mask, selected] of subsets) {
    totalOfferProbability += selected.probability;
    for (let index = 0; index < input.length; index++) if (mask & 2 ** index) inclusion[index] += selected.probability;
  }
  return {
    status: 'ok', totalOfferProbability, offerCount: count, subsetCount: subsets.size,
    outcomes: input.map((item, index) => ({
      id: item.id, inclusionProbability: inclusion[index], probability: inclusion[index] / count,
    })),
  };
}

export function getGemProcessingMarginals(input) {
  const candidates = getGemProcessingCandidates(input);
  if (candidates.status !== 'ok') return candidates;
  const result = calculateWeightedOfferMarginals(candidates.candidates);
  if (result.status !== 'ok') return result;
  let supportedProbability = 0;
  let unavailableProbability = 0;
  const outcomes = result.outcomes.map((outcome, index) => {
    const reason = candidates.candidates[index].unverifiedReason;
    if (reason) unavailableProbability += outcome.probability;
    else supportedProbability += outcome.probability;
    return { ...outcome, transitionStatus: reason ? 'unavailable' : 'ok', ...(reason ? { reason } : {}) };
  });
  return { ...result, modelVersion: GEM_PROCESSING_MODEL.version, assumptions: GEM_PROCESSING_MODEL.assumptions, outcomes, supportedProbability, unavailableProbability };
}

export function getGemProcessingCost(input) {
  const state = normalizeState(input);
  if (!state) return { ...unavailable('invalid_processing_state'), gold: null };
  if (state.remainingAttempts === 0) return { status: 'complete', gold: null };
  const baseGold = GEM_PROCESSING_STARTS[state.grade].baseGold;
  if (baseGold === null) return { ...unavailable('base_processing_gold_unverified'), gold: null };
  return { status: 'ok', baseGold, modifier: state.costModifier, gold: baseGold * (1 + state.costModifier) };
}

export function applyGemProcessingOutcome(input, outcomeId) {
  const state = normalizeState(input);
  if (!state) return unavailable('invalid_processing_state');
  const outcome = GEM_PROCESSING_OUTCOMES.find(candidate => candidate.id === outcomeId);
  if (!outcome || !eligible(state, outcome)) return unavailable('outcome_ineligible');
  const cost = getGemProcessingCost(state);
  const effectChoices = outcome.kind === 'effect' ? getGemEffectChangeChoices(state, outcome.effectIndex).choices : null;
  state.processedCount += 1;
  state.remainingAttempts -= 1;
  if (outcome.kind === 'axis') state.points[outcome.axis] += outcome.delta;
  if (outcome.kind === 'reroll') state.rerollsRemaining += outcome.delta;
  if (outcome.kind === 'cost') state.costModifier += outcome.delta;
  const branches = effectChoices
    ? effectChoices.map(choice => {
      const next = { ...state, points: [...state.points], effects: [...state.effects] };
      next.effects[outcome.effectIndex] = choice.effect;
      return { probability: choice.probability, state: next };
    })
    : [{ probability: 1, state }];
  return {
    status: 'ok', state: branches.length === 1 ? state : null, branches,
    cost, nextCost: getGemProcessingCost(state), assumptions: GEM_PROCESSING_MODEL.assumptions,
  };
}

export function applyGemProcessingOffer(input, outcomeIds) {
  const state = normalizeState(input);
  if (!state) return unavailable('invalid_processing_state');
  if (!Array.isArray(outcomeIds) || outcomeIds.length !== 4 || new Set(outcomeIds).size !== 4)
    return unavailable('invalid_processing_offer');
  const pool = getGemProcessingCandidates(state);
  if (pool.status !== 'ok' || Array.from(outcomeIds).some(id => !pool.candidates.some(candidate => candidate.id === id)))
    return unavailable('invalid_processing_offer');
  const outcomes = outcomeIds.flatMap(id => {
    const result = applyGemProcessingOutcome(state, id);
    return result.branches.map(branch => ({
      id, status: 'ok', probability: .25 * branch.probability, state: branch.state,
      cost: result.cost, nextCost: result.nextCost,
    }));
  });
  return { status: 'ok', assumptions: GEM_PROCESSING_MODEL.assumptions, outcomes };
}

export function refreshGemProcessingOffer(input) {
  const state = normalizeState(input);
  if (!state) return unavailable('invalid_processing_state');
  if (state.processedCount === 0) return unavailable('refresh_before_first_processing');
  if (state.remainingAttempts === 0 || state.rerollsRemaining === 0) return unavailable('refresh_unavailable');
  state.rerollsRemaining -= 1;
  // No previous-offer exclusion: a refresh can repeat previously shown items.
  return { status: 'ok', state };
}
