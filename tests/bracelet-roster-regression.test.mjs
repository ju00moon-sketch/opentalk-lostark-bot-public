import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, icon, tooltip } from './helpers/native-efficiency-fixture.mjs';
import { analyzeNativeEfficiency } from '../src/native-character-efficiency.js';
import { calculateBraceletAttackContext } from '../src/bracelet-attack-context.js';
import { readBraceletExpectationInput } from '../src/bracelet-expectation-input.js';
import { analyzeBraceletExpectation } from '../src/character-bracelet-expectation.js';

test('vitality is a known non-damage bracelet stat and does not suppress other efficiency', () => {
  const base = fixture(`${icon}치명 +100`);
  const withVitality = fixture(`${icon}치명 +100<BR>${icon}체력 +4,760`);
  const before = analyzeNativeEfficiency(base).bracelet;
  const actual = analyzeNativeEfficiency(withVitality).bracelet;
  assert.equal(actual.status, 'ok'); assert.equal(actual.efficiency, before.efficiency);
  assert.deepEqual(actual.omitted, []);
  assert.equal(analyzeNativeEfficiency(fixture(`${icon}체력 +4,7x0`)).bracelet.status, 'unavailable');
});

test('explicitly empty official grid shapes retain bracelet attack and efficiency', () => {
  // Effects:null with an empty slot list is the official shape of cores without gem effects (2026-09-18).
  for (const ArkGrid of [null, { Slots: null, Effects: null }, { Slots: [], Effects: null }]) {
    const raw = fixture(`${icon}민첩 +12000`); raw.ArkGrid = ArkGrid;
    const expected = calculateBraceletAttackContext(fixture(`${icon}민첩 +12000`));
    const actual = calculateBraceletAttackContext(raw);
    assert.deepEqual(actual.missing, []); assert.equal(actual.with, expected.with); assert.equal(actual.without, expected.without);
    assert.equal(analyzeNativeEfficiency(raw).bracelet.status, 'ok');
  }
});

test('missing or conflicting grid shapes remain unknown rather than becoming zero', () => {
  for (const ArkGrid of [undefined, {}, { Slots: null }, { Effects: null }, { Slots: [] }, { Effects: [] }]) {
    const raw = fixture(`${icon}민첩 +12000`); raw.ArkGrid = ArkGrid;
    assert.equal(calculateBraceletAttackContext(raw).with, null);
    assert.equal(analyzeNativeEfficiency(raw).bracelet.status, 'unavailable');
  }
});

test('known lower-grade cores outside bracelet baseline tables do not invalidate a comparison', () => {
  const raw = fixture();
  raw.ArkGrid.Slots = [
    { Index: 0, Name: '질서의 달 코어 : 교차된 힘', Grade: '전설', Point: 0 },
    { Index: 1, Name: '질서의 별 코어 : 마무리 일격', Grade: '전설', Point: 10 },
    { Index: 2, Name: '질서의 해 코어 : 예측불가', Grade: '전설', Point: 10 },
    { Index: 3, Name: '혼돈의 해 코어 : 안정적인 공격', Grade: '전설', Point: 0 },
  ];
  assert.equal(analyzeNativeEfficiency(raw).bracelet.status, 'ok');
  for (const grade of ['새등급', ['전설']]) {
    const changed = structuredClone(raw); changed.ArkGrid.Slots[0].Grade = grade;
    assert.equal(analyzeNativeEfficiency(changed).bracelet.status, 'unavailable');
  }
});

const inputItem = (text, extra = {}) => ({ Type: '팔찌', Grade: '고대', Tooltip: JSON.stringify({
  title: { type: 'ItemTitle', value: { leftStr2: '아이템 티어 4' } },
  effects: { type: 'ItemPartBox', value: { Element_000: '팔찌 효과', Element_001:
    `<img src='emoticon_tooltip_bracelet_locked'></img>치명 +100<BR><img src='emoticon_tooltip_bracelet_locked'></img>특화 +100<BR>${icon}${text}<BR>${icon}민첩 +12000` } },
  ...extra,
}) });

test('official damage-taken wording preserves the exact seed-reduction target tier', () => {
  const line = '시드 등급 이하 몬스터에게 받는 피해량이 6% 감소한다.';
  const parsed = readBraceletExpectationInput(inputItem(line));
  assert.equal(parsed.status, 'ok'); assert.deepEqual(parsed.input.granted[0], { id: 'special.seedReduction', tier: 1 });
  assert.equal(analyzeBraceletExpectation({ ArmoryEquipment: [inputItem(line)] }).status, 'ok');
  for (const changed of [line.replace('6%', '6.1%'), line.replace('감소', '증가'), line.replace('이하', '이상'), line + ' 추가 조건.']) {
    assert.equal(readBraceletExpectationInput(inputItem(changed)).status, 'unavailable');
  }
});

test('the explicit non-grantable bracelet label gives a specific unsupported reason', () => {
  const completed = inputItem('체력 +4000', { label: { type: 'SingleTextBox', value: '<FONT>효과 부여 불가</FONT>' } });
  assert.equal(readBraceletExpectationInput(completed).status, 'ok');
  const item = structuredClone(completed); item.Tooltip = item.Tooltip.replaceAll('bracelet_changeable', 'bracelet_locked');
  const actual = analyzeBraceletExpectation({ ArmoryEquipment: [item] });
  assert.equal(actual.status, 'unavailable'); assert.match(actual.reason, /효과 부여 불가/);
  assert.equal(readBraceletExpectationInput(inputItem('체력 +4000')).status, 'ok');
});

test('observed conditional engravings keep a stated boss-target and maximum-stack baseline', () => {
  const raw = fixture(`${icon}민첩 +12000`);
  raw.ArmoryEngraving.ArkPassiveEffects = [
    { Name: '승부사', Grade: '유물', Level: 0, AbilityStoneLevel: null, Description: '적을 처치할 때 마다 <FONT>40</FONT>초 동안, 공격력이 <FONT>2.10%</FONT> 증가한다. (최대 <FONT>8</FONT>중첩)' },
    { Name: '선수필승', Grade: '유물', Level: 0, AbilityStoneLevel: null, Description: '생명력이 최대인 시드 등급 이하 몬스터에게 공격 적중 시 치명타 적중률이 100%로 적용된다. 또한 이 치명타는 <FONT>140.00%</FONT>의 추가 치명타 배율을 가진다.' },
  ];
  const actual = analyzeNativeEfficiency(raw).bracelet;
  assert.equal(actual.status, 'ok');
  assert.equal(actual.diagnostics.attack.engravingAttackPercent, 16.8);
  assert.ok(actual.assumptions.some(line => line.includes('승부사') && line.includes('8중첩')));
  assert.ok(actual.assumptions.some(line => line.includes('선수필승') && line.includes('보스')));
  for (const mutate of [
    copy => copy.ArmoryEngraving.ArkPassiveEffects[0].Description += ' 별도 조건.',
    copy => copy.ArmoryEngraving.ArkPassiveEffects[0].Description = copy.ArmoryEngraving.ArkPassiveEffects[0].Description.replace('2.10%', '-2.10%'),
    copy => copy.ArmoryEngraving.ArkPassiveEffects[1].Description = copy.ArmoryEngraving.ArkPassiveEffects[1].Description.replace('시드 등급 이하', '보스 등급 이상'),
  ]) {
    const copy = structuredClone(raw); mutate(copy);
    assert.equal(analyzeNativeEfficiency(copy).bracelet.status, 'unavailable');
  }
});
