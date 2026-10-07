// 일반 재련 최저 비용 경로 — 매 시도마다 숨결 몇 개·책을 쓸지 골라 기대 골드를 가장 낮춘다.
//
// 기존 `honing-valuation.js`는 보조 재료를 쓰지 않는 기대비용이라 「최저 비용 경로가 아닙니다」라고
// 스스로 밝혀 두었다. 여기서 그 선택을 푼다. 확률·재료 표는 기존 모델 것을 그대로 쓰고,
// 보조 재료 수치만 `data/honing-boost.js`에서 가져온다.
//
// 푸는 방법: 한 단계 안의 상태는 (실패 횟수, 장인의 기운) 둘뿐이다. 실패 보너스는 10회에서 멈추고
// 장인의 기운은 실패할 때마다 반드시 올라가므로, 기운이 큰 쪽부터 거꾸로 채우면 정확한 답이 나온다.
//   V(k, e) = min over 선택 [ 이번 시도 비용 + (1 - 성공확률) × V(k+1, e') ]
// 기운이 가득 차면 다음 시도는 확정 성공이라 보조 재료를 쓸 이유가 없다.
import { HONING_MODEL, HONING_STAGES } from './data/honing-valuation.js';
import { BREATH_NAMES, bookName, breathLimit } from './data/honing-boost.js';

const ENERGY_FULL = 1000;           // 장인의 기운을 천분율 정수로 센다(기존 모델과 같은 단위)
const FAIL_STACK_MAX = HONING_MODEL.artisan.maximumFailureStacks;
export const WALK_LIMIT = 400;      // 정책을 앞으로 훑을 때의 안전 상한
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

// 쓸 수 있는 보조 재료 조합. 숨결 개수 × 책 사용 여부.
function buildChoices({ successBps, breath, book }) {
  const choices = [];
  const breathMax = breath ? breath.count : 0;
  for (const withBook of book ? [false, true] : [false]) {
    for (let used = 0; used <= breathMax; used++) {
      const breathBps = breath ? Math.min(used * breath.perBps, breath.capBps) : 0;
      choices.push({
        breath: used, book: withBook,
        addBps: breathBps + (withBook ? successBps : 0),
        gold: (breath ? used * breath.unitGold : 0) + (withBook ? book.unitGold : 0),
      });
      // 한도에 닿은 뒤로는 더 넣어 봐야 확률이 그대로고 값만 비싸다.
      if (breath && breathBps >= breath.capBps) break;
    }
  }
  return choices;
}

// 한 단계의 최저 기대 비용과 그때의 선택. attemptGold는 보조 재료를 뺀 1회 시도 비용이다.
export function optimizeStage({ successBps, failBonusBps, attemptGold, breath = null, book = null } = {}) {
  if (!Number.isInteger(successBps) || successBps < 1 || successBps > 10000
    || !Number.isInteger(failBonusBps) || failBonusBps < 0 || !finite(attemptGold)) return null;
  const choices = buildChoices({ successBps, breath, book });
  const coefficient = HONING_MODEL.artisan.coefficient;
  const value = Array.from({ length: FAIL_STACK_MAX + 1 }, () => new Float64Array(ENERGY_FULL + 1));
  const pick = Array.from({ length: FAIL_STACK_MAX + 1 }, () => new Int32Array(ENERGY_FULL + 1));

  // 기운이 가득이면 확정 성공 — 보조 재료 없이 한 번만 두드린다.
  for (let stacks = 0; stacks <= FAIL_STACK_MAX; stacks++) value[stacks][ENERGY_FULL] = attemptGold;

  const attemptProbability = (stacks, addBps) => Math.min(10000, successBps + stacks * failBonusBps + addBps) / 10000;
  const energyGain = probability => Math.max(1, Math.round(probability * coefficient * ENERGY_FULL));

  // 실패하면 기운은 반드시 오르므로 큰 쪽부터 채우면 뒤를 참조할 일이 없다.
  for (let energy = ENERGY_FULL - 1; energy >= 0; energy--) {
    for (let stacks = FAIL_STACK_MAX; stacks >= 0; stacks--) {
      let best = Infinity, bestIndex = 0;
      for (const [index, choice] of choices.entries()) {
        const probability = attemptProbability(stacks, choice.addBps);
        const next = Math.min(ENERGY_FULL, energy + energyGain(probability));
        const total = attemptGold + choice.gold
          + (1 - probability) * value[Math.min(FAIL_STACK_MAX, stacks + 1)][next];
        if (total < best) { best = total; bestIndex = index; }
      }
      value[stacks][energy] = best;
      pick[stacks][energy] = bestIndex;
    }
  }

  // 고른 정책을 앞으로 훑어 "몇 회차에 무엇을 넣는지"를 읽을 수 있게 만든다.
  // 현재 재련 표 밖의 극저확률(예: 1bps·실패 보너스 0)은 WALK_LIMIT에서 계획이 잘릴 수 있다.
  // 이때 DP 비용은 전체 경로, 시도 수·plan은 일부 경로이므로 상세 응답은 summarizeHoningPlan에서 거절한다.
  const plan = [];
  let stacks = 0, energy = 0, reach = 1, expectedAttempts = 0;
  for (let attempt = 1; attempt <= WALK_LIMIT; attempt++) {
    const guaranteed = energy >= ENERGY_FULL;
    const choice = guaranteed ? choices[0] : choices[pick[stacks][energy]];
    const probability = guaranteed ? 1 : attemptProbability(stacks, choice.addBps);
    plan.push({ attempt, breath: choice.breath, book: choice.book, gold: attemptGold + choice.gold,
      successBps: Math.round(probability * 10000), artisanBps: Math.round(energy * 10), reachProbability: reach, guaranteed });
    expectedAttempts += reach;
    if (probability >= 1) break;
    reach *= 1 - probability;
    energy = Math.min(ENERGY_FULL, energy + energyGain(probability));
    stacks = Math.min(FAIL_STACK_MAX, stacks + 1);
  }

  return { status: 'ok', expectedGold: value[0][0], expectedAttempts, maximumAttempts: plan.length, plan, segments: planSegments(plan) };
}

// 계획을 "같은 선택이 이어지는 구간"으로 묶는다. 표시 계층이 앞 몇 줄만 보고 판단하지 않게
// 전체 계획에서 만든다 — 계획이 수백 회차여도 실제 선택이 바뀌는 지점은 몇 개뿐이다.
export function planSegments(plan) {
  const segments = [];
  for (const row of plan ?? []) {
    const last = segments[segments.length - 1];
    if (last && last.breath === row.breath && last.book === row.book && last.guaranteed === row.guaranteed) {
      last.to = row.attempt;
      continue;
    }
    segments.push({ from: row.attempt, to: row.attempt, breath: row.breath, book: row.book,
      guaranteed: row.guaranteed, reachProbability: row.reachProbability });
  }
  return segments;
}

// 최적 정책의 유한 종료 분포. 게임 모델은 바꾸지 않고 이미 고른 회차를 합산한다.
export function summarizeHoningPlan(plan, growthGold = 0) {
  if (!Array.isArray(plan) || !plan.length || plan.length > WALK_LIMIT || !finite(growthGold)
    || plan.at(-1).successBps !== 10000) return null;
  let cumulativeGold = growthGold, expectedGold = growthGold, expectedAttempts = 0;
  let reach = 1;
  const rows = [];
  for (const [index, row] of plan.entries()) {
    if (row.attempt !== index + 1 || !Number.isInteger(row.successBps) || row.successBps < 1 || row.successBps > 10000
      || !finite(row.gold) || !finite(row.reachProbability) || Math.abs(row.reachProbability - reach) > 1e-12
      || !Number.isInteger(row.breath) || row.breath < 0 || typeof row.book !== 'boolean'
      || !Number.isInteger(row.artisanBps) || row.artisanBps < 0 || row.artisanBps > 10000
      || (row.successBps === 10000 && index !== plan.length - 1)) return null;
    const probability = row.successBps / 10000;
    cumulativeGold += row.gold;
    expectedGold += reach * row.gold;
    expectedAttempts += reach;
    rows.push({ attempt: row.attempt, successBps: row.successBps, artisanBeforeBps: row.artisanBps,
      artisanAfterFailureBps: probability === 1 ? null : plan[index + 1]?.artisanBps,
      reachProbability: reach, successProbability: reach * probability,
      cumulativeSuccessProbability: 1 - reach * (1 - probability),
      breathQuantity: row.breath, bookQuantity: Number(row.book), attemptGold: row.gold,
      cumulativeGold, guaranteed: row.guaranteed });
    reach *= 1 - probability;
  }
  if (![cumulativeGold, expectedGold, expectedAttempts].every(finite)) return null;
  const last = rows.at(-1);
  return { expectedGold, expectedAttempts, plan: rows,
    worstCase: { attempts: rows.length, gold: cumulativeGold, reachProbability: last.reachProbability,
      terminal: last.guaranteed ? 'artisan_guarantee' : 'success_probability_100' },
    percentiles: [0.5, 0.9].map(probability => {
      const row = rows.find(item => item.cumulativeSuccessProbability >= probability);
      return { probability, attempts: row.attempt, gold: row.cumulativeGold, cumulativeProbability: row.cumulativeSuccessProbability };
    }) };
}

function stageDetails({ rule, best, attemptGold, growthGold, growthShards, priceOf, breathItem, breathGold, limit, book, bookGold }) {
  const summary = summarizeHoningPlan(best.plan, growthGold);
  if (!summary) return null;
  const materials = [];
  const add = (name, source, unitGold, availability, perAttemptQuantity, oneTimeQuantity, quantities) => {
    const { first, expected, worst } = quantities;
    const cost = quantity => quantity === null ? null : quantity === 0 ? 0 : quantity * unitGold;
    materials.push({ name, source, unit: name === '골드' ? 'gold' : 'item', unitGold, availability,
      perAttemptQuantity, oneTimeQuantity, firstAttemptQuantity: first,
      expectedQuantity: expected, expectedGold: cost(expected), worstCaseQuantity: worst, worstCaseGold: cost(worst) });
  };
  for (const [name, quantity] of [...Object.entries(rule.materials), ['운명의 파편', rule.shards], ['골드', rule.gold]]) {
    add(name, 'base', name === '골드' ? 1 : priceOf(name), 'known', quantity, 0,
      { first: quantity, expected: quantity * summary.expectedAttempts, worst: quantity * best.plan.length });
  }
  add('운명의 파편', 'growth', priceOf('운명의 파편'), growthShards === null ? 'quantity_unverified' : 'known', 0, growthShards,
    { first: growthShards, expected: growthShards, worst: growthShards });
  const breathCoverage = !limit ? 'rule_unverified' : !finite(breathGold) ? 'price_unavailable' : 'available';
  const bookCoverage = book === null ? 'not_applicable' : !finite(bookGold) ? 'price_unavailable' : 'available';
  for (const [source, name, unit, coverage] of [['breath', breathItem, breathGold, breathCoverage], ['book', book, bookGold, bookCoverage]]) {
    if (coverage === 'not_applicable') continue;
    const count = row => source === 'breath' ? row.breath : Number(row.book);
    add(name, source, finite(unit) ? unit : null, coverage === 'available' ? 'known' : coverage, null, 0,
      { first: count(best.plan[0]), expected: best.plan.reduce((sum, row) => sum + row.reachProbability * count(row), 0),
        worst: best.plan.reduce((sum, row) => sum + count(row), 0) });
  }
  const breathCost = materials.find(row => row.source === 'breath');
  const bookCost = materials.find(row => row.source === 'book');
  const firstAttempt = { baseGold: attemptGold,
    breathGold: breathCost.firstAttemptQuantity * (breathCost.unitGold ?? 0),
    bookGold: bookCost ? bookCost.firstAttemptQuantity * (bookCost.unitGold ?? 0) : 0,
    growthGold, totalGold: best.plan[0].gold + growthGold };
  return { materials, firstAttempt, worstCase: summary.worstCase, percentiles: summary.percentiles,
    coverage: { growthShards: growthShards === null ? 'unverified' : 'known', breath: breathCoverage, book: bookCoverage,
      excluded: ['silver', 'bound_inventory_offsets'] }, plan: summary.plan };
}

// 한 장비의 from→to 구간. prices는 재료 이름 → 개당 골드(없으면 null)를 돌려주는 함수다.
// 보조 재료 시세나 자료가 없으면 그 재료를 빼고 계산하고 사유를 남긴다 — 추측해서 채우지 않는다.
export function optimizeHoning({ kind, from, to, priceOf, family = 't4', includeDetails = false } = {}) {
  if (!['weapon', 'armor'].includes(kind) || typeof priceOf !== 'function') return null;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from) return null;
  const table = family === 'vambrace' ? HONING_STAGES.vambrace
    : HONING_STAGES[`${family}${kind === 'weapon' ? 'Weapon' : 'Armor'}`];
  if (!table) return null;

  const breathItem = BREATH_NAMES[kind];
  const breathGold = priceOf(breathItem);
  const notes = new Set();
  const stages = [];
  let total = 0;

  for (let current = from; current < to; current++) {
    const rule = table[current];
    if (!rule) return { status: 'unavailable', reason: 'stage_unverified', stage: current };

    // 1회 시도에 드는 기본 비용 — 고정 골드 + 재료 + 파편. 하나라도 시세가 없으면 계산하지 않는다.
    let attemptGold = rule.gold;
    for (const [material, quantity] of Object.entries(rule.materials)) {
      const unit = priceOf(material);
      if (!finite(unit)) return { status: 'unavailable', reason: 'material_price_unavailable', material };
      attemptGold += unit * quantity;
    }
    const shardGold = priceOf('운명의 파편');
    if (!finite(shardGold)) return { status: 'unavailable', reason: 'material_price_unavailable', material: '운명의 파편' };
    attemptGold += shardGold * rule.shards;

    // 장비 성장 파편은 시도마다가 아니라 **단계마다 한 번** 든다. 기존 honing-valuation.js도 이렇게 센다.
    // 자료가 없는 낮은 단계는 0으로 두되 빠진 사실을 남긴다 — 추측해서 채우지 않는다.
    const growthShards = Number.isInteger(rule.growthShards) && rule.growthShards >= 0 ? rule.growthShards : null;
    if (growthShards === null) notes.add('growth_shards_unverified');
    const growthGold = growthShards === null ? 0 : shardGold * growthShards;

    const limit = breathLimit(rule.successBps);
    if (!limit) notes.add('breath_table_missing');
    else if (!finite(breathGold)) notes.add('breath_price_unavailable');
    const book = bookName(family, kind, rule.to);
    const bookGold = book === null ? null : priceOf(book);
    if (book === null) notes.add('book_none_for_stage');
    else if (!finite(bookGold)) notes.add('book_price_unavailable');

    const usableBreath = limit && finite(breathGold) ? { ...limit, unitGold: breathGold } : null;
    const usableBook = book !== null && finite(bookGold) ? { name: book, unitGold: bookGold } : null;
    const best = optimizeStage({ successBps: rule.successBps, failBonusBps: rule.failBonusBps, attemptGold,
      breath: usableBreath, book: usableBook });
    const plain = optimizeStage({ successBps: rule.successBps, failBonusBps: rule.failBonusBps, attemptGold });
    if (!best || !plain) return { status: 'unavailable', reason: 'honing_probability_unverified', stage: current };

    const details = includeDetails ? stageDetails({ rule, best, attemptGold, growthGold, growthShards, priceOf,
      breathItem, breathGold, limit, book, bookGold }) : null;
    if (includeDetails && !details) return { status: 'unavailable', reason: 'honing_unavailable', stage: current };

    // 성장 파편은 어떤 선택을 해도 같은 금액이라 최저 비용과 맨몸 비용에 똑같이 더한다(아끼는 금액은 그대로).
    total += best.expectedGold + growthGold;
    stages.push({ from: rule.from, to: rule.to, successBps: rule.successBps, attemptGold, growthGold,
      breathName: usableBreath ? breathItem : null, bookName: usableBook ? usableBook.name : null,
      expectedGold: best.expectedGold + growthGold, expectedAttempts: best.expectedAttempts,
      plainGold: plain.expectedGold + growthGold, savedGold: plain.expectedGold - best.expectedGold,
      plan: best.plan, segments: best.segments, ...(includeDetails ? { details } : {}) });
  }

  return { status: 'ok', kind, from, to, family, expectedGold: total,
    plainGold: stages.reduce((sum, stage) => sum + stage.plainGold, 0), stages, notes: [...notes] };
}
