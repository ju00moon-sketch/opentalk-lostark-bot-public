import { HONING_MODEL, HONING_STAGES, HONING_ADVANCED, HONING_TEMPERING } from './data/honing-valuation.js';

const integer = (value, low, high) => Number.isSafeInteger(value) && value >= low && value <= high;
const normalCache = new Map(), advancedCache = new Map();
const assumptions = [
  '일반 장비는 티어 4 재련 18단계·상급 재련 20단계(1700), 완갑은 0단계부터 계산합니다.',
  '숨결·야금술·재봉술·특수 재련을 사용하지 않는 기준이며 최저 비용 경로가 아닙니다.',
  '현재 시세로 재료를 모두 구매하는 기대비용이며 과거 실제 지출을 복원하지 않습니다.',
  '각 일반 재련 단계는 실패 0회·장인의 기운 0에서 시작합니다.',
  '장인 증가량은 공개 계산 도구의 성공확률×0.465 및 확률 단위 소수 셋째 자리 반올림 모형을 사용합니다.',
  '상급 재련은 시작 경험치·가호 구슬 0에서 목표 단계에 도달하거나 넘을 때까지 계산합니다.',
  '에베르의 즉시 단계 상승 시 잔여 경험치를 0으로 만드는 공개 계산 도구의 전이를 사용합니다.',
  '장비 성장 파편과 상급 재련 구간의 담금질 파편은 각각 한 번 포함하고 실링·귀속 레이드 재료는 골드 환산에서 제외합니다.'
];
const unavailable = (target, reason) => ({ status: 'unavailable', targetKey: typeof target?.targetKey === 'string' ? target.targetKey : null,
  modelVersion: HONING_MODEL.version, reason, requirements: [], quotes: [], fixedGold: null, assumptions: [...assumptions] });
const copy = value => structuredClone(value);

export function evaluateNormalHoning(rule) {
  if (!rule || !integer(rule.successBps, 1, 10000) || !integer(rule.failBonusBps, 0, 10000)) {
    return { status: 'unavailable', reason: 'invalid_honing_probability' };
  }
  const key = `${rule.successBps}:${rule.failBonusBps}`;
  if (normalCache.has(key)) return copy(normalCache.get(key));
  let reach = 1, energy = 0, expectedAttempts = 0, successProbability = 0;
  const steps = [];
  // Energy is kept as integer thousandths, matching the observed rounding
  // rule. At least one unit is gained on failure, so this loop is bounded.
  for (let failures = 0; failures <= 1000; failures++) {
    const guaranteed = energy >= 1000;
    const probability = guaranteed ? 1 : Math.min(1, (rule.successBps + Math.min(failures, 10) * rule.failBonusBps) / 10000);
    steps.push({ attempt: failures + 1, reachProbability: reach, successProbability: probability,
      artisanEnergy: energy / 1000, guaranteed });
    expectedAttempts += reach;
    successProbability += reach * probability;
    if (probability === 1) break;
    reach *= 1 - probability;
    energy += Math.max(1, Math.round(probability * HONING_MODEL.artisan.coefficient * 1000));
  }
  const result = { status: 'ok', expectedAttempts, successProbability, maximumAttempts: steps.length, steps };
  if (normalCache.size >= 128) normalCache.delete(normalCache.keys().next().value);
  normalCache.set(key, result); return copy(result);
}

function addMaterials(into, rows, multiplier) {
  for (const [name, quantity] of Object.entries(rows)) into[name] = (into[name] ?? 0) + quantity * multiplier;
}

export function evaluateAdvancedHoning(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { status: 'unavailable', reason: 'invalid_advanced_honing_range' };
  const { equipmentType, startStage, targetStage } = input;
  if (!['weapon', 'armor'].includes(equipmentType) || !integer(startStage, 20, 40) || !integer(targetStage, startStage, 40)) {
    return { status: 'unavailable', reason: 'invalid_advanced_honing_range' };
  }
  const rules = HONING_ADVANCED[equipmentType];
  const cacheKey = `${equipmentType}:${startStage}:${targetStage}`;
  if (advancedCache.has(cacheKey)) return copy(advancedCache.get(cacheKey));
  const memo = new Map();
  // Vector[0] = all attempts. Vector[1..4] = paid attempts per segment.
  const visit = (stage, exp, orbs, enhanced, free) => {
    if (stage >= targetStage) return [0, 0, 0, 0, 0];
    const key = `${stage}:${exp}:${orbs}:${+enhanced}:${+free}`;
    if (memo.has(key)) return memo.get(key);
    const index = Math.floor(stage / 10), rule = rules[index];
    const value = [1, 0, 0, 0, 0]; value[index + 1] = free ? 0 : 1;
    const blessing = orbs === 6;
    const effects = !blessing ? [{ probability: 1, multiplier: 1, bonus: 0, advance: 0 }]
      : enhanced ? rule.enhancedBlessings : rule.blessings;
    for (const outcome of rule.outcomes) for (const effect of effects) {
      const probability = outcome.probability * effect.probability;
      let nextStage = stage, nextExp = exp, nextOrbs, nextEnhanced, nextFree;
      if (effect.advance) { nextStage += effect.advance; nextExp = 0; }
      else { nextExp += outcome.experience * effect.multiplier + effect.bonus;
        nextStage += Math.floor(nextExp / 100); nextExp %= 100; }
      if (nextStage >= rule.to) {
        nextStage = rule.to; nextExp = 0; nextOrbs = 0; nextEnhanced = false; nextFree = false;
      } else if (blessing) {
        nextOrbs = effect.refill ? 6 : 0; nextEnhanced = !!effect.enhanced; nextFree = !!effect.freeNext;
      } else { nextOrbs = orbs + 2; nextEnhanced = false; nextFree = false; }
      const next = visit(nextStage, nextExp, nextOrbs, nextEnhanced, nextFree);
      for (let i = 0; i < value.length; i++) value[i] += next[i] * probability;
    }
    memo.set(key, value); return value;
  };
  const vector = visit(startStage, 0, 0, false, false);
  const materials = {}, segments = [];
  let fixedGold = 0, excludedSilver = 0;
  for (const [index, rule] of rules.entries()) {
    const paid = vector[index + 1]; if (!paid) continue;
    fixedGold += rule.gold * paid; excludedSilver += rule.silver * paid;
    addMaterials(materials, rule.materials, paid);
    segments.push({ from: Math.max(startStage, rule.from), to: Math.min(targetStage, rule.to), expectedPaidAttempts: paid });
  }
  const result = { status: 'ok', expectedAttempts: vector[0], fixedGold, excludedSilver, materials, segments, evaluatedStates: memo.size };
  if (advancedCache.size >= 128) advancedCache.delete(advancedCache.keys().next().value);
  advancedCache.set(cacheKey, result); return copy(result);
}

const MATERIAL_GRADES = {
  '운명의 파괴석': '일반', '운명의 수호석': '일반', '운명의 파괴석 결정': '일반', '운명의 수호석 결정': '일반',
  '운명의 돌파석': '희귀', '위대한 운명의 돌파석': '희귀', '아비도스 융화 재료': '희귀',
  '상급 아비도스 융화 재료': '영웅', '운명의 파편 주머니(대)': '영웅'
};

function normalizeTarget(target) {
  if (!target || target.status !== 'ok' || target.kind !== 'honing' || target.tier !== 4 ||
      typeof target.targetKey !== 'string' || !/^[a-f0-9]{64}$/.test(target.targetKey) ||
      !['무기', '투구', '상의', '하의', '장갑', '어깨', '완갑'].includes(target.slot) ||
      !integer(target.refinement, 0, 25) || typeof target.itemName !== 'string' ||
      !['observed', 'unobserved'].includes(target.advancedRefinementStatus)) return null;
  const level = target.refinement;
  if (target.slot === '완갑') {
    if (!/^운명의 전율\s.+/.test(target.itemName) || target.advancedRefinement !== null ||
        !['영웅', '전설', '유물', '고대'].includes(target.grade)) return null;
    const bounds = { 영웅: [0, 10], 전설: [10, 15], 유물: [15, 20], 고대: [20, 25] }[target.grade];
    if (level < bounds[0] || level > bounds[1]) return null;
    return { family: 'vambrace', equipmentType: 'vambrace', level, advanced: 0 };
  }
  const equipmentType = target.slot === '무기' ? 'weapon' : 'armor';
  if (/^운명의 전율\s.+/.test(target.itemName) && target.grade === '고대') {
    if (level < 11 || target.advancedRefinement !== null || target.itemLevel !== 1675 + 5 * level) return null;
    return { family: 'serka', equipmentType, level, advanced: 40 };
  }
  if (/^운명의 (?:업화|결단)\s.+/.test(target.itemName) && ['유물', '고대'].includes(target.grade)) {
    const inferred = target.itemLevel - (1590 + 5 * level);
    const unobserved = target.advancedRefinementStatus === 'unobserved' && target.advancedRefinement === null;
    if (!integer(target.itemLevel, 1590, 1800) || !integer(inferred, 0, 40) ||
        (!unobserved && (target.advancedRefinementStatus !== 'observed' || target.advancedRefinement !== inferred))) return null;
    return { family: 't4', equipmentType, level, advanced: inferred, inferredAdvanced: unobserved };
  }
  return null;
}

export function getHoningValuationRecipe(target) {
  const item = normalizeTarget(target);
  if (!item) return unavailable(target, 'honing_target_unverified');
  const materials = {}, steps = [], excluded = ['실링', '담금질·장비 제작·계승·완갑 해방의 귀속 레이드 재료'];
  let fixedGold = 0, excludedSilver = 0;
  const normal = (family, from, to) => {
    const key = family === 'vambrace' ? family : `${family}${item.equipmentType === 'weapon' ? 'Weapon' : 'Armor'}`;
    for (let current = from; current < to; current++) {
      const rule = HONING_STAGES[key]?.[current];
      if (!rule || !integer(rule.growthShards, 0, 1e9) || !integer(rule.growthSilver, 0, 1e10)) throw new Error('growth_cost_unverified');
      const result = evaluateNormalHoning(rule);
      if (result.status !== 'ok') throw new Error('honing_probability_unverified');
      fixedGold += rule.gold * result.expectedAttempts;
      excludedSilver += rule.growthSilver + rule.silver * result.expectedAttempts;
      addMaterials(materials, rule.materials, result.expectedAttempts);
      addMaterials(materials, { '운명의 파편': rule.growthShards + rule.shards * result.expectedAttempts }, 1);
      steps.push({ kind: 'normal', family, from: current, to: current + 1, expectedAttempts: result.expectedAttempts,
        maximumAttempts: result.maximumAttempts, growthShards: rule.growthShards });
    }
  };
  const advanced = to => {
    if (to <= 20) return;
    for (const fee of HONING_TEMPERING[item.equipmentType]) {
      if (to <= fee.from) continue;
      addMaterials(materials, { '운명의 파편': fee.shards }, 1);
      excludedSilver += fee.silver;
      steps.push({ kind: 'tempering', from: fee.from, to: fee.to, shards: fee.shards, excludedSilver: fee.silver });
    }
    const result = evaluateAdvancedHoning({ equipmentType: item.equipmentType, startStage: 20, targetStage: to });
    if (result.status !== 'ok') throw new Error('advanced_rule_unverified');
    fixedGold += result.fixedGold; excludedSilver += result.excludedSilver;
    addMaterials(materials, result.materials, 1);
    steps.push({ kind: 'advanced', from: 20, to, expectedAttempts: result.expectedAttempts, segments: result.segments });
  };
  try {
    if (item.family === 'vambrace') normal('vambrace', 0, item.level);
    else if (item.family === 'serka') {
      normal('t4', 18, 20); advanced(40);
      steps.push({ kind: 'transfer', from: { refinement: 20, advancedRefinement: 40 }, to: { refinement: 11, advancedRefinement: null } });
      normal('serka', 11, item.level);
    } else { normal('t4', 18, item.level); advanced(item.advanced); }
  } catch (error) { return unavailable(target, error.message); }
  const quotes = [], requirements = [];
  for (const [material, quantity] of Object.entries(materials).sort(([a], [b]) => a.localeCompare(b))) {
    const name = material === '운명의 파편' ? '운명의 파편 주머니(대)' : material;
    const grade = MATERIAL_GRADES[name];
    if (!grade || !Number.isFinite(quantity) || quantity < 0) return unavailable(target, 'honing_material_unverified');
    const quoteKey = `honing:${name}`;
    quotes.push({ quoteKey, kind: 'market', category: 50010, name, grade });
    requirements.push({ quoteKey, quantity: material === '운명의 파편' ? quantity / 3000 : quantity });
  }
  return { status: 'ok', targetKey: target.targetKey, modelVersion: HONING_MODEL.version,
    basisStatus: steps.length ? 'above_baseline' : 'at_or_below_baseline', requirements, fixedGold, quotes,
    materials, excludedSilver, excluded, steps, assumptions: [...assumptions,
      ...(item.inferredAdvanced ? ['상급 재련 단계는 현재 아이템 레벨에서 기본 장비 레벨(1590+재련단계×5)을 빼서 역산했습니다.'] : []),
      ...(item.family === 'serka' ? ['운명의 전율 장비는 업화 재련20·상급40에서 전율11로 계승하는 기준 경로를 사용합니다.'] : [])],
    sources: copy(HONING_MODEL.sources) };
}
