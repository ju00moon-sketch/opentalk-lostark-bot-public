// Numerical facts transcribed from the official T4 probability table (2025-12-30).
// Tier numbers follow the table's low / middle / high rows, not numeric direction.
const freeze = value => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

const rangeWeights = [10, 16, 16, 16, 10, 10, 10, 4, 4, 4];
const ranges = (start, width) => rangeWeights.map((weight, i) => ({
  min: start + i * width + (i === 0 ? 0 : 1),
  max: start + (i + 1) * width,
  weight,
}));
const stat = (id, label, category, weight, relic, ancient) => ({
  id, label, category, fixedAllowed: true, weight,
  ranges: { relic, ancient },
});
const special = (id, label, group, relic, ancient, matchTerms) => ({
  id: `special.${id}`, label, category: 'special', fixedAllowed: group === 'ordinary',
  tierWeights: group === 'ordinary' ? [4.2, 2.1, 0.7]
    : group === 'rare' ? [0.5, 0.25, 0.08333] : [1.0909, 0.5455, 0.1818],
  fixedTierWeights: group === 'ordinary' ? [6, 3, 1] : null,
  tiers: { relic: relic.map((values, i) => ({ tier: i + 1, values: [].concat(values) })),
    ancient: ancient.map((values, i) => ({ tier: i + 1, values: [].concat(values) })) },
  matchTerms,
});

export const BRACELET_T4_EFFECTS = freeze([
  stat('base.mainStat', '힘·민첩·지능', 'base', 50, ranges(6400, 640), ranges(9600, 640)),
  stat('base.vitality', '체력', 'base', 50, ranges(3000, 200), ranges(4000, 200)),
  ...[['crit', '치명'], ['specialization', '특화'], ['domination', '제압'],
    ['swiftness', '신속'], ['endurance', '인내'], ['expertise', '숙련']]
    .map(([id, label]) => stat(`combat.${id}`, label, 'combat', 16.6667,
      ranges(41, 5).map((row, i) => ({ ...row, min: 41 + i * 6, max: 46 + i * 6 })),
      ranges(61, 5).map((row, i) => ({ ...row, min: 61 + i * 6, max: 66 + i * 6 })))),
  special('attackMoveSpeed', '공격·이동 속도', 'ordinary', [3, 4, 5], [4, 5, 6], ['공격 및 이동 속도']),
  special('seedDamage', '시드 이하 피해', 'ordinary', [3, 4, 5], [4, 5, 6], ['시드 등급 이하', '주는 피해']),
  special('seedReduction', '시드 이하 피해 감소', 'ordinary', [4, 6, 8], [6, 8, 10], ['시드 등급 이하', '받는 피해']),
  special('physicalDefense', '물리 방어력', 'ordinary', [4000, 5000, 6000], [5000, 6000, 7000], ['물리 방어력']),
  special('magicalDefense', '마법 방어력', 'ordinary', [4000, 5000, 6000], [5000, 6000, 7000], ['마법 방어력']),
  special('maxHp', '최대 생명력', 'ordinary', [8400, 11200, 14000], [11200, 14000, 16800], ['최대 생명력']),
  special('hpRegen', '전투 중 생명력 회복량', 'ordinary', [80, 100, 130], [100, 130, 160], ['전투 중 생명력 회복량']),
  special('resourceRegen', '전투자원 자연 회복량', 'ordinary', [6, 8, 10], [8, 10, 12], ['전투자원 자연 회복량']),
  special('movementCooldown', '이동기·기상기 재사용 감소', 'ordinary', [6, 8, 10], [8, 10, 12], ['이동기 및 기상기']),
  special('immunity', '경직·피격 이상 면역', 'ordinary', [90, 80, 70], [80, 70, 60], ['경직 및 피격 이상', '면역']),
  special('critRateDamage', '치명타 적중률·치명타 적중 피해', 'rare', [[2.6, 1.5], [3.4, 1.5], [4.2, 1.5]], [[3.4, 1.5], [4.2, 1.5], [5, 1.5]], ['치명타 적중률', '치명타로 적중']),
  special('critDamageDamage', '치명타 피해·치명타 적중 피해', 'rare', [[5.2, 1.5], [6.8, 1.5], [8.4, 1.5]], [[6.8, 1.5], [8.4, 1.5], [10, 1.5]], ['치명타 피해', '치명타로 적중']),
  special('damageStagger', '주는 피해·무력화 피해', 'rare', [[1.5, 3.5], [2, 4], [2.5, 4.5]], [[2, 4], [2.5, 4.5], [3, 5]], ['주는 피해', '무력화 상태']),
  special('additionalDemon', '추가 피해·악마 피해', 'rare', [[2, 2.5], [2.5, 2.5], [3, 2.5]], [[2.5, 2.5], [3, 2.5], [3.5, 2.5]], ['추가 피해', '악마 및 대악마']),
  special('cooldownDamage', '재사용 증가·주는 피해', 'rare', [[2, 4], [2, 4.5], [2, 5]], [[2, 4.5], [2, 5], [2, 5.5]], ['재사용 대기 시간', '증가하지만']),
  special('defenseDebuff', '대상 방어력 감소·아군 공격력 강화', 'rare', [[1.5, 1.5], [1.8, 2], [2.1, 2.5]], [[1.8, 2], [2.1, 2.5], [2.5, 3]], ['대상의 방어력', '아군 공격력']),
  special('critResistanceDebuff', '대상 치명타 저항 감소·아군 공격력 강화', 'rare', [[1.5, 1.5], [1.8, 2], [2.1, 2.5]], [[1.8, 2], [2.1, 2.5], [2.5, 3]], ['대상의 치명타 저항', '아군 공격력']),
  special('protectionDamage', '보호 대상 피해·아군 공격력 강화', 'rare', [[0.7, 1.5], [0.9, 2], [1.1, 2.5]], [[0.9, 2], [1.1, 2.5], [1.3, 3]], ['보호 효과가 적용된 대상', '아군 공격력']),
  special('critDamageResistanceDebuff', '대상 치명타 피해 저항 감소·아군 공격력 강화', 'rare', [[3, 1.5], [3.6, 2], [4.2, 2.5]], [[3.6, 2], [4.2, 2.5], [4.8, 3]], ['치명타 피해 저항', '아군 공격력']),
  special('weaponAttackSpeedStack', '무기 공격력·공격 이동 속도 중첩', 'rare', [1000, 1160, 1320], [1160, 1320, 1480], ['매 초', '최대 6중첩']),
  special('weaponAttackHp', '무기 공격력·생명력 조건', 'rare', [[6300, 1800], [7200, 2000], [8100, 2200]], [[7200, 2000], [8100, 2200], [9000, 2400]], ['무기 공격력', '생명력이']),
  special('weaponAttackLongStack', '무기 공격력·장기 중첩', 'rare', [[6000, 120], [6900, 130], [7800, 140]], [[6900, 130], [7800, 140], [8700, 150]], ['무기 공격력', '최대 30중첩']),
  special('damage', '주는 피해', 'common', [1.5, 2, 2.5], [2, 2.5, 3], ['적에게 주는 피해']),
  special('additionalDamage', '추가 피해', 'common', [2.5, 3, 3.5], [3, 3.5, 4], ['추가 피해']),
  special('backAttackDamage', '백어택 피해', 'common', [2, 2.5, 3], [2.5, 3, 3.5], ['백어택 스킬']),
  special('headAttackDamage', '헤드어택 피해', 'common', [2, 2.5, 3], [2.5, 3, 3.5], ['헤드어택 스킬']),
  special('nonDirectionalDamage', '방향성 없는 스킬 피해', 'common', [2, 2.5, 3], [2.5, 3, 3.5], ['방향성 공격이 아닌 스킬']),
  special('partyProtection', '파티원 보호·회복', 'common', [2, 2.5, 3], [2.5, 3, 3.5], ['파티원 보호 및 회복']),
  special('partyAttackBuff', '아군 공격력 강화', 'common', [3, 4, 5], [4, 5, 6], ['아군 공격력 강화']),
  special('partyDamageBuff', '아군 피해량 강화', 'common', [4.5, 6, 7.5], [6, 7.5, 9], ['아군 피해량 강화']),
  special('critRate', '치명타 적중률', 'common', [2.6, 3.4, 4.2], [3.4, 4.2, 5], ['치명타 적중률']),
  special('critDamage', '치명타 피해', 'common', [5.2, 6.8, 8.4], [6.8, 8.4, 10], ['치명타 피해']),
  special('weaponAttack', '무기 공격력', 'common', [6300, 7200, 8100], [7200, 8100, 9000], ['무기 공격력']),
]);

export const BRACELET_T4_DATA = freeze({
  version: '2025-12-30', checkedAt: '2026-09-16',
  sources: {
    probability: 'https://lostark.game.onstove.com/Probability/%ED%8C%94%EC%B0%8C%20T4',
    guide: 'https://lostark.game.onstove.com/GameGuide/Pages/%EC%9E%A5%EB%B9%84',
    initialRollsImage: 'https://cdn-lostark.game.onstove.com/uploadfiles/notice/2026/bac8771503b24f0a936a9a511bb3798b.png',
    t4RollsImage: 'https://cdn-lostark.game.onstove.com/uploadfiles/notice/2026/622d5043b4084bfea646eda8aa92849a.png',
  },
  categoryWeights: { base: 35, combat: 35, special: 30 },
  categoryLimits: { base: 2, combat: 2, special: 5 },
  fixedCounts: [{ count: 1, weight: 65 }, { count: 2, weight: 35 }],
  grantedCounts: { relic: [{ count: 1, weight: 75 }, { count: 2, weight: 25 }],
    ancient: [{ count: 2, weight: 75 }, { count: 3, weight: 25 }] },
  normalRolls: 4, maxReconversionTickets: 3, silverCosts: null,
});
