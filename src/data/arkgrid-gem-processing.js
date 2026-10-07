// Numeric facts from the official processing probability table. One weight unit
// is 0.01 percentage point; actual outcomes also depend on the four-offer draw.
const freeze = value => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

export const GEM_PROCESSING_MODEL = freeze({
  version: '2026-09-16.3-transitions',
  probabilitySource: 'https://lostark.game.onstove.com/Probability/%EC%A0%AC%20%EA%B0%80%EA%B3%B5,%20%EC%A0%AC%20%EC%9C%B5%ED%95%A9',
  probabilityPublishedAt: '2025-08-20',
  observedAt: '2026-09-16',
  offerCount: 4,
  offeredOutcomeProbability: 0.25,
  initialAxisValue: 1,
  minAxisValue: 1,
  maxAxisValue: 5,
  unverified: ['uncommon_base_gold'],
  assumptions: ['효과 변경은 이름만 변경하고 현재 레벨을 유지'],
  // The official table separates effect-identity replacement from level
  // changes. Level preservation is the model's documented interpretation,
  // rather than an additional explicit sentence in that table.
  effectLevelRule: 'preserved-by-model-interpretation',
  scope: 'Candidate probabilities and verified one-step transitions; no completed-gem cost solver.',
});

export const GEM_PROCESSING_SUBTYPES = freeze({
  안정: { family: '질서', baseWillpower: 8, effects: ['공격력', '추가 피해', '아군 피해 강화', '낙인력'] },
  침식: { family: '혼돈', baseWillpower: 8, effects: ['공격력', '추가 피해', '아군 피해 강화', '낙인력'] },
  견고: { family: '질서', baseWillpower: 9, effects: ['공격력', '보스 피해', '아군 피해 강화', '아군 공격 강화'] },
  왜곡: { family: '혼돈', baseWillpower: 9, effects: ['공격력', '보스 피해', '아군 피해 강화', '아군 공격 강화'] },
  불변: { family: '질서', baseWillpower: 10, effects: ['추가 피해', '보스 피해', '낙인력', '아군 공격 강화'] },
  붕괴: { family: '혼돈', baseWillpower: 10, effects: ['추가 피해', '보스 피해', '낙인력', '아군 공격 강화'] },
});

// The current Korean guide images show 5/7/9 attempts and epic/rare 900 gold.
// The uncommon base fee is not visible and remains unverified.
export const GEM_PROCESSING_STARTS = freeze({
  고급: { attempts: 5, rerolls: 0, baseGold: null },
  희귀: { attempts: 7, rerolls: 1, baseGold: 900 },
  영웅: { attempts: 9, rerolls: 2, baseGold: 900 },
});

export const GEM_PROCESSING_SOURCES = freeze({
  koreanGuide: 'https://lostark.game.onstove.com/GameGuide/Pages/%EC%95%84%ED%81%AC%20%EA%B7%B8%EB%A6%AC%EB%93%9C',
  currentGradeAttemptsImage: 'https://cdn-lostark.game.onstove.com/uploadfiles/notice/2026/a83bef3d3f8442d0b59794b8afd41e47.png',
  koreanProcessingImage: 'https://cdn-lostark.game.onstove.com/uploadfiles/notice/359196095d384e05bdb1602350023a6f.png',
  koreanInitialTooltip: 'https://cdn-lostark.game.onstove.com/uploadfiles/notice/2500fdb94fe34649bca2fc8181eb8a93.png',
  // Only matching mechanical facts (willpower and refresh counts) are used.
  // Western trade/binding/currency rules differ and are not imported.
  supplementaryMechanics: 'https://www.playlostark.com/en-us/game/releases/day-of-prophecy',
});

const axisDeltas = [
  { suffix: 'plus1', delta: 1, weight: 1165 },
  { suffix: 'plus2', delta: 2, weight: 440 },
  { suffix: 'plus3', delta: 3, weight: 175 },
  { suffix: 'plus4', delta: 4, weight: 45 },
  { suffix: 'minus1', delta: -1, weight: 300 },
];

export const GEM_PROCESSING_OUTCOMES = freeze([
  ...[0, 1, 2, 3].flatMap(axis => axisDeltas.map(({ suffix, delta, weight }) => ({
    id: `axis${axis}.${suffix}`, kind: 'axis', axis, delta, weight,
  }))),
  { id: 'effect0.change', kind: 'effect', effectIndex: 0, weight: 325 },
  { id: 'effect1.change', kind: 'effect', effectIndex: 1, weight: 325 },
  { id: 'cost.plus100', kind: 'cost', delta: 1, weight: 175 },
  { id: 'cost.minus100', kind: 'cost', delta: -1, weight: 175 },
  { id: 'unchanged', kind: 'unchanged', weight: 175 },
  { id: 'reroll.plus1', kind: 'reroll', delta: 1, weight: 250 },
  { id: 'reroll.plus2', kind: 'reroll', delta: 2, weight: 75 },
]);
