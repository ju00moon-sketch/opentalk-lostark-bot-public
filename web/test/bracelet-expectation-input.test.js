import test from 'node:test';
import assert from 'node:assert/strict';
import { readBraceletExpectationInput } from '../../src/bracelet-expectation-input.js';
import { analyzeBraceletExpectation } from '../../src/character-bracelet-expectation.js';
import { buildBaseBraceletSearch } from '../../src/bracelet-base-price.js';

const item = (granted, fixed = ['치명 +83', '특화 +90']) => ({ Type: '팔찌', Grade: '고대', Tooltip: JSON.stringify({
  title: { type: 'ItemTitle', value: { leftStr2: '아이템 티어 4' } },
  effects: { type: 'ItemPartBox', value: { Element_000: '팔찌 효과', Element_001:
    [...fixed.map(text => `<img src='emoticon_tooltip_bracelet_locked'></img>${text}`),
      ...granted.map(text => `<img src='emoticon_tooltip_bracelet_changeable'></img>${text}`)].join('<BR>') } },
}) });

// Relevant official armory fields from a completed, upgraded ancient bracelet.
const upgradedBracelet = () => ({ Type: '팔찌', Grade: '고대', Tooltip: JSON.stringify({
  title: { type: 'ItemTitle', value: { leftStr2: "<FONT SIZE='14'>아이템 티어 4</FONT>" } },
  effects: { type: 'ItemPartBox', value: { Element_000: "<FONT COLOR='#A9D0F5'>팔찌 효과</FONT>",
    Element_001: "<img src='emoticon_tooltip_bracelet_locked' vspace='-5'></img> 치명 <FONT COLOR='#00B5FF'>+92</FONT><BR>"
      + "<img src='emoticon_tooltip_bracelet_locked' vspace='-5'></img> 신속 <FONT COLOR='#91FE02'>+71</FONT><BR>"
      + "<img src='emoticon_tooltip_bracelet_locked' vspace='-5'></img> 치명타 적중률이 <FONT COLOR='#00B5FF'>3.4%</FONT> 증가한다.<BR>공격이 치명타로 적중 시 적에게 주는 피해가 <FONT COLOR='#99ff99'>1.5%</FONT> 증가한다.<BR>"
      + "<img src='emoticon_tooltip_bracelet_locked' vspace='-5'></img> 치명타 피해 <FONT COLOR='#FE9600'>+10.00%</FONT><BR>"
      + "<img src='emoticon_tooltip_bracelet_changeable' width='20' height='20' vspace='-6'></img>치명타 적중률 <FONT COLOR='#00B5FF'>+3.40%</FONT>" } },
  complete: { type: 'SingleTextBox', value: "<FONT COLOR='#C24B46'>효과 부여 불가</FONT>" },
}) });

test('completed five-option upgrade restores two initial fixed slots without splitting its locked compound', () => {
  const value = upgradedBracelet(), before = structuredClone(value);
  const parsed = readBraceletExpectationInput(value);
  assert.equal(parsed.status, 'ok');
  assert.deepEqual(parsed.input.fixed, [{ id: 'combat.crit', value: 92 }, { id: 'combat.swiftness', value: 71 }]);
  assert.deepEqual(parsed.input.granted, [
    { id: 'special.critRateDamage', tier: 1 }, { id: 'special.critDamage', tier: 3 }, { id: 'special.critRate', tier: 1 },
  ]);
  assert.deepEqual(parsed.target.map(row => row.fixed), [true, true, false, false, false]);
  const result = analyzeBraceletExpectation({ ArmoryEquipment: [value] });
  assert.equal(result.status, 'ok'); assert.equal(result.fixedCount, 2); assert.equal(result.grantedCount, 3);
  assert.equal(result.totalRolls, 7); assert.equal(result.reconversionTickets, 3);
  assert(result.successProbability > 0 && result.successProbability < 1);
  const normal = item(parsed.target.filter(row => !row.fixed).map(row => row.text), ['치명 +92', '신속 +71']);
  const normalResult = analyzeBraceletExpectation({ ArmoryEquipment: [normal] });
  assert.equal(result.targetKey, normalResult.targetKey);
  assert.equal(result.successProbability, normalResult.successProbability);
  const search = buildBaseBraceletSearch(result);
  assert.equal(search.status, 'ok'); assert.equal(search.fixedCount, 2); assert.equal(search.grantedCount, 3);
  assert.deepEqual(search.conditions.map(({ name, value, min, max }) => ({ name, value, min, max })), [
    { name: '치명', value: 92, min: 87, max: 97 }, { name: '신속', value: 71, min: 66, max: 76 },
  ]);
  assert.deepEqual(search.body.EtcOptions.filter(row => row.FirstOption === 4), [
    { FirstOption: 4, SecondOption: 1, MinValue: 2, MaxValue: 2 },
    { FirstOption: 4, SecondOption: 2, MinValue: 3, MaxValue: 3 },
  ]);
  assert.deepEqual(value, before);
});

test('upgrade recovery does not accept a different compound, ambiguous slots or all-fixed event items', () => {
  const mutate = change => { const value = upgradedBracelet(), tooltip = JSON.parse(value.Tooltip); change(tooltip, value); value.Tooltip = JSON.stringify(tooltip); return value; };
  for (const value of [
    mutate(t => { t.effects.value.Element_001 = t.effects.value.Element_001.replace('1.5%', '1.6%'); }),
    mutate(t => { t.effects.value.Element_001 = t.effects.value.Element_001.replace('적중 시', '미적중 시'); }),
    mutate(t => { t.effects.value.Element_001 = t.effects.value.Element_001.replace('3.4%', '3.41%'); }),
    mutate(t => { t.effects.value.Element_001 = t.effects.value.Element_001.replace('1.5%</FONT> 증가한다.', '1.5%</FONT> 증가한다. 별도 조건이 적용된다.'); }),
    mutate(t => { delete t.complete; }),
    mutate((t, v) => { v.Grade = '유물'; }),
    mutate(t => { t.effects.value.Element_001 = t.effects.value.Element_001.replace('bracelet_changeable', 'bracelet_locked'); }),
    mutate(t => { t.effects.value.Element_001 = t.effects.value.Element_001.replace(/<img[^>]+><\/img> 신속.*?<BR>/, ''); }),
    mutate(t => { t.effects.value.Element_001 = t.effects.value.Element_001.replace('치명 <FONT', '치명타 피해 <FONT').replace('+92', '+10.00%'); }),
    mutate(t => { t.effects.value.Element_001 = t.effects.value.Element_001.replace("치명타 피해 <FONT COLOR='#FE9600'>+10.00%</FONT>", '민첩 +12000'); }),
    mutate(t => { t.effects.value.Element_001 = t.effects.value.Element_001.replace("치명타 피해 <FONT COLOR='#FE9600'>+10.00%</FONT>", '최대 생명력 +16800'); }),
    mutate(t => { t.effects.value.Element_001 = t.effects.value.Element_001.replace('bracelet_locked', 'bracelet_changeable').replace(/bracelet_changeable(?=' width)/, 'bracelet_locked'); }),
  ]) assert.equal(analyzeBraceletExpectation({ ArmoryEquipment: [value] }).status, 'unavailable');
});

test('compound continuation belongs to one slot and exact values select the published tier', () => {
  const value = item(['민첩 +14,912', '치명타 피해가 8.4% 증가한다.<BR>공격이 치명타로 적중 시 적에게 주는 피해가 1.5% 증가한다.',
    '치명타 적중률이 5% 증가한다.<BR>공격이 치명타로 적중 시 적에게 주는 피해가 1.5% 증가한다.']);
  const parsed = readBraceletExpectationInput(value);
  assert.equal(parsed.status, 'ok'); assert.equal(parsed.input.granted.length, 3);
  assert.deepEqual(parsed.input.granted, [{ id: 'base.mainStat', value: 14912 }, { id: 'special.critDamageDamage', tier: 2 }, { id: 'special.critRateDamage', tier: 3 }]);
  const result = analyzeBraceletExpectation({ ArmoryEquipment: [value] });
  assert.equal(result.status, 'ok'); assert.equal(result.scenarios.length, 1);
  assert.equal(parsed.input.reconversionTickets, 3);
  assert.equal(result.reconversionTickets, 3); assert.equal(result.totalRolls, 7);
  assert.equal(result.probabilityByRoll.length, 7); assert.match(result.targetKey, /^[a-f0-9]{64}$/);
  assert(result.successProbability > result.initialGrantProbability);
  assert.equal(result.startingBraceletGold, null); assert.equal(result.expectedStartingBraceletGold, null);
  const rolls=result.probabilityByRoll;
  const expectedTickets=rolls.slice(3,6).reduce((total,row)=>total+1-row.successProbability,0);
  assert(Math.abs(result.expectedReconversionTicketsPerBracelet-expectedTickets)<1e-10);
  assert(result.expectedReconversionTicketsPerBracelet>0 && result.expectedReconversionTicketsPerBracelet<3);
  assert.equal(result.expectedReconversionTicketsUntilSuccess,result.expectedReconversionTicketsPerBracelet*result.expectedStartingBracelets);
  assert.equal(result.scenarios[0].reconversionTickets,3);
  assert(result.successProbability>rolls[3].successProbability);
  assert.equal(result.reconversionTicketUnitGold,null);assert.equal(result.reconversionTicketCostGold,null);
});

test('only the exact official protection definition can supplement a complete probability row', () => {
  const text = '파티 효과로 보호 효과(보호막, 생명력 회복, 받는 피해 감소)가 적용된 대상이 5초 동안 적에게 주는 피해가 1.1% 증가한다. 해당 효과는 한 파티 당 하나만 적용되며, 지속 시간이 없는 보호 효과에는 적용되지 않는다. 아군 공격력 강화 효과가 2.5% 증가한다.';
  const parsed = readBraceletExpectationInput(item([text, '지능 +10049']));
  assert.equal(parsed.status, 'ok'); assert.deepEqual(parsed.input.granted[0], { id: 'special.protectionDamage', tier: 2 });
  for (const altered of [text.replace('5초', '6초'), text.replace('받는 피해 감소', '주는 피해 증가'), text.replace('1.1%', '1.11%'), text + ' 별도 조건이 적용된다.']) {
    assert.equal(readBraceletExpectationInput(item([altered, '지능 +10049'])).status, 'unavailable');
  }
});

test('negative tradeoff and immunity timers use their exact tier rather than the first number', () => {
  const parsed = readBraceletExpectationInput(item(['스킬의 재사용 대기 시간이 2% 증가하지만, 적에게 주는 피해가 5.5% 증가한다.',
    '공격 적중 시 80초 동안 경직 및 피격 이상에 면역이 된다. (재사용 대기 시간 80초) 해당 효과는 1회 피격 시 사라진다.']));
  assert.equal(parsed.status, 'ok');
  assert.deepEqual(parsed.input.granted, [{ id: 'special.cooldownDamage', tier: 3 }, { id: 'special.immunity', tier: 1 }]);
});

test('unknown numeric clauses, tiers, invalid tooltip and ambiguous markers never fabricate probability', () => {
  for (const text of ['치명타 적중률이 5.1% 증가한다.', '치명타 적중률이 5% 증가한다. 추가 피해가 5% 증가한다.', '치명 +1,00', '전설의 효과 +123',
    '적에게 주는 피해가 2.0% 감소한다.', '적에게 주는 피해가 -2.0% 증가한다.', '적에게 주는 피해가 2.0000000000000001% 증가한다.',
    '적에게 주는 피해가 2.0% 증가한다. 단, 특정 몬스터에게만 적용된다.',
    '몬스터에게 공격 적중 시 80초 동안 대상의 방어력을 1.8% 감소시킨다. 해당 효과는 한 파티 당 하나만 적용된다. 아군 공격력 강화 효과가 2.0% 증가한다.']) {
    assert.equal(readBraceletExpectationInput(item([text, '민첩 +12000'])).status, 'unavailable', text);
  }
  for (const Tooltip of ['null', '[]', '{}', 'broken', 'x'.repeat(131073)]) {
    assert.equal(readBraceletExpectationInput({ Type: '팔찌', Grade: '고대', Tooltip }).status, 'unavailable');
  }
  const missingMarker = item(['치명타 적중률이 5% 증가한다.', '민첩 +12000']);
  missingMarker.Tooltip = missingMarker.Tooltip.replaceAll('bracelet_changeable', 'bracelet_unknown');
  assert.equal(analyzeBraceletExpectation({ ArmoryEquipment: [missingMarker] }).status, 'unavailable');
  assert.equal(analyzeBraceletExpectation({ ArmoryEquipment: [] }).status, 'unavailable');
});

test('weapon attack stacking effect has one flat value and a separate percent clause', () => {
  const value = item(['공격 적중 시 매 초 마다 10초 동안 무기 공격력이 1160, 공격 및 이동 속도가 1% 증가한다.(최대 6중첩)', '민첩 +12000']);
  assert.deepEqual(readBraceletExpectationInput(value).input.granted[0], { id: 'special.weaponAttackSpeedStack', tier: 1 });
});

test('duplicated families, impossible stat counts, and non-T4 equipment do not pass as zero chance', () => {
  for (const value of [item(['치명 +97', '민첩 +12000']), item(['치명타 적중률이 5% 증가한다.', '치명타 적중률이 4.2% 증가한다.']),
    { ...item(['민첩 +12000', '치명타 적중률이 5% 증가한다.']), Grade: '전설' }]) {
    assert.equal(analyzeBraceletExpectation({ ArmoryEquipment: [value] }).status, 'unavailable');
  }
});
