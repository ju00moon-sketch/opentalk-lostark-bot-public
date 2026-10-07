// Numerical facts from the official T3 probability table, checked 2026-09-16.
// Special rows encode low/middle/high occurrence weights, not unverified effect values.
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const rangeWeights = [10, 16, 16, 16, 10, 10, 10, 4, 4, 4];
const ranges = start => rangeWeights.map((weight, i) => ({min:start + i * 250 + (i ? 1 : 0),max:start + (i + 1) * 250,weight}));
const combatRanges = start => rangeWeights.map((weight, i) => ({min:start + i * 6,max:start + i * 6 + 5,weight}));
const stat = (id,label,category,weight,relic,ancient) => ({id,label,category,fixedAllowed:true,weight,ranges:{relic,ancient}});
const special = (id,label,group) => ({id:`special.t3${id}`,label,category:'special',group,fixedAllowed:group==='ordinary',
  tierWeights:group==='ordinary'?[2.1,1.05,.35]:group==='rare'?[.6667,.3333,.1111]:[1.0909,.5455,.1818],
  fixedTierWeights:group==='ordinary'?[3,1.5,.5]:null});

export const BRACELET_T3_EFFECTS = freeze([
  stat('base.mainStat','힘·민첩·지능','base',50,ranges(1500),ranges(2500)),
  stat('base.vitality','체력','base',50,ranges(500),ranges(1500)),
  ...[['crit','치명'],['specialization','특화'],['domination','제압'],['swiftness','신속'],['endurance','인내'],['expertise','숙련']]
    .map(([id,label])=>stat(`combat.${id}`,label,'combat',16.6667,combatRanges(41),combatRanges(61))),
  ...[['MaxHp','최대 생명력'],['MaxMana','최대 마나'],['PhysicalDefense','물리 방어력'],['MagicalDefense','마법 방어력'],
    ['Recovery','오뚝이'],['Charge','돌진'],['Smash','강타'],['Strike','타격'],['ManaRecovery','마나 회수'],['QuickAttack','속공'],
    ['Investment','투자'],['Reversal','반전'],['Counterattack','반격'],['Contempt','멸시'],['Ignore','무시'],['HpRecovery','전투 중 생명력 회복'],
    ['Revival','회생'],['Transfusion','긴급 수혈'],['FirstAid','응급 처치'],['Encore','앵콜']].map(([id,label])=>special(id,label,'ordinary')),
  ...[['Wedge','쐐기'],['Hammer','망치'],['Cycle','순환'],['Passion','열정'],['Cold','냉정'],['Dagger','비수'],
    ['Weakness','약점노출'],['Enlightenment','깨달음'],['Cheer','응원']].map(([id,label])=>special(id,label,'rare')),
  ...[['Harvest','수확'],['Reward','보상'],['WeaponAttack','무기 공격력'],['Superiority','우월'],['Raid','습격'],['Precision','정밀'],
    ['Wound','상처악화'],['Rage','분개'],['Ambush','기습'],['Duel','결투'],['Accumulation','적립']].map(([id,label])=>special(id,label,'common')),
]);

export const BRACELET_T3_DATA = freeze({
  version:'2024-09-25-t3',checkedAt:'2026-09-16',itemTier:3,
  sources:{
    probability:'https://lostark.game.onstove.com/Probability/%ED%8C%94%EC%B0%8C%20T3',
    guide:'https://lostark.game.onstove.com/GameGuide/Pages/%EC%9E%A5%EB%B9%84',
    initialRollsImage:'https://cdn-lostark.game.onstove.com/uploadfiles/notice/2026/bac8771503b24f0a936a9a511bb3798b.png',
  },
  categoryWeights:{base:35,combat:35,special:30},categoryLimits:{base:2,combat:2,special:5},
  fixedCounts:[{count:1,weight:65},{count:2,weight:35}],
  grantedCounts:{relic:[{count:1,weight:75},{count:2,weight:25}],ancient:[{count:2,weight:75},{count:3,weight:25}]},
  // The official image is a T3 bracelet before its first grant. Extra tickets are explicitly T4-only.
  normalRolls:4,maxReconversionTickets:0,silverCosts:null,
  assumptions:['published-weights-normalized','special-limit-from-tier-specific-probability-table','no-upgrade','t3-no-reconversion-tickets'],
});
