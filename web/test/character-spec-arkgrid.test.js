import test from 'node:test';
import assert from 'node:assert/strict';
import { mapCharacterSpecData } from '../src/character-spec-data.js';

const image = 'https://cdn-lostark.game.onstove.com/efui_iconatlas/use/use_13_202.png';
const tip = (...parts) => JSON.stringify(Object.fromEntries(parts.map((part, index) => [`Element_${index}`, part])));
const part = (title, text) => ({ type: 'ItemPartBox', value: { Element_000: title, Element_001: text } });
const gem = (Index = 0) => ({ Index, Icon: image, Grade: '전설', IsActive: true, Tooltip: tip(
  { type: 'NameTagBox', value: '<FONT>질서의 젬 : 안정</FONT>' },
  part('젬 기본 정보', '젬 타입 : 질서<BR>젬 포인트 : <FONT>15</FONT>'),
  part('젬 효과', '필요 의지력 : <FONT>3</FONT> (기본 값 8 – 의지력 효율 5)<BR>질서 포인트 : 5<BR>[아군 피해 강화] Lv.2<BR>아군 피해량 강화 효과 +0.10%'),
) });
const core = (Index = 0) => ({ Index, Icon: image, Name: '질서의 해 코어 : 대지 붕괴', Grade: '고대', Point: 20,
  Tooltip: tip(part('코어 공급 의지력', '17 포인트'), part('코어 옵션', '[10P] 기력 스킬의 피해량이 1.5% 증가한다.<BR>[20P] 기력 스킬의 치명타 피해량이 0.4% 증가한다.'),
    part('코어 옵션 발동 조건', '극의: 체술 전용')), Gems: [gem(0), { ...gem(1), IsActive: false }] });
const source = () => ({ Slots: [core()], Effects: [{ Name: '아군 피해 강화', Level: 14, Tooltip: "아군 피해량 강화 효과 <font color='#ffd200'>+0.73%</font>" }] });
const mapped = raw => mapCharacterSpecData({ arkgrid: raw }).arkgrid;

test('official grid slots preserve core options and socketed gems with distinct point meanings', () => {
  const raw = source(), before = structuredClone(raw), grid = mapped(raw);
  const item = grid.cores[0], one = item.gems[0];
  assert.equal(item.slot, 0); assert.equal(item.name, '질서의 해 코어 : 대지 붕괴');
  assert.equal(item.points, 20); assert.equal(item.grade, '고대'); assert.equal(item.icon, image);
  assert.equal(item.sections[0].entries[0].text, '17 포인트');
  assert.deepEqual(item.sections[1].entries.map(row => row.text), [
    '[10P] 기력 스킬의 피해량이 1.5% 증가한다.', '[20P] 기력 스킬의 치명타 피해량이 0.4% 증가한다.',
  ]);
  assert.equal(item.sections[2].title, '코어 옵션 발동 조건');
  assert.equal(one.slot, 0); assert.equal(one.name, '질서의 젬 : 안정');
  assert.equal(one.points, 15); assert.equal(one.corePoints, 5); assert.equal(one.willpower, 3);
  assert.equal(one.isActive, true); assert.equal(item.gems[1].isActive, false);
  assert.ok(one.sections[1].entries.some(row => row.text === '[아군 피해 강화] Lv.2'));
  assert.equal(Object.hasOwn(one, 'level'), false);
  assert.deepEqual(grid.effects, [{ name: '아군 피해 강화', level: 14,
    entries: [{ text: '아군 피해량 강화 효과 +0.73%', values: [{ value: 0.73, unit: '%' }], truncated: false }] }]);
  assert.deepEqual(raw, before);
});

test('unknown grid sections differ from an empty received loadout and malformed sockets are isolated', () => {
  for (const raw of [undefined, null, {}, [], { Slots: null }, { Slots: [null] }, { Slots: [core(0), core(0)] },
    { Slots: Array.from({ length: 7 }, (_, index) => core(index)) }, { Slots: [{ ...core(), Name: null }] }]) assert.equal(mapped(raw), null);
  assert.deepEqual(mapped({ Slots: [], Effects: [] }), { cores: [], effects: [] });
  assert.deepEqual(mapped({ Slots: [], Effects: null }), { cores: [], effects: null });
  for (const Gems of [{}, [null], [gem(0), gem(0)], Array.from({ length: 5 }, (_, index) => gem(index))]) {
    const grid = mapped({ Slots: [{ ...core(), Gems }], Effects: [] });
    assert.equal(grid.cores[0].gems, null); assert.equal(grid.cores[0].points, 20);
  }
  // A core with no gem is published as `Gems: null` (or without the key at all): an observed empty set.
  for (const Gems of [[], null, undefined]) {
    const grid = mapped({ Slots: [{ ...core(), Gems }], Effects: [] });
    assert.deepEqual(grid.cores[0].gems, []); assert.equal(grid.cores[0].points, 20);
  }
  for (const Effects of [undefined, null, {}, [null], [{ Name: null }], Array.from({ length: 33 }, () => ({ Name: '효과' }))]) {
    const grid = mapped({ Slots: [core()], Effects });
    assert.equal(grid.effects, null); assert.equal(grid.cores.length, 1);
  }
});

test('slot identities reject out-of-range, fractional, missing and duplicate values', () => {
  for (const Index of [undefined, null, '0', false, -1, 0.5, 6, NaN, Infinity]) {
    assert.equal(mapped({ Slots: [{ ...core(), Index }] }), null);
  }
  for (const Index of [undefined, null, '0', false, -1, 0.5, 4, NaN, Infinity]) {
    assert.equal(mapped({ Slots: [{ ...core(), Gems: [{ ...gem(), Index }] }] }).cores[0].gems, null);
  }
});

test('missing and invalid point, activation and level values never become a zero', () => {
  for (const value of [undefined, null, '', '20', false, -1, 0.5, 10001, NaN, Infinity]) {
    const grid = mapped({ Slots: [{ ...core(), Point: value, Gems: [{ ...gem(), IsActive: value, Tooltip: '{}' }] }],
      Effects: [{ Name: '효과', Level: value }] });
    assert.equal(grid.cores[0].points, null); assert.equal(grid.effects[0].level, null);
    const one = grid.cores[0].gems[0];
    assert.equal(one.isActive, typeof value === 'boolean' ? value : null);
    assert.equal(one.points, null); assert.equal(one.corePoints, null); assert.equal(one.willpower, null);
    assert.equal(one.name, null);
  }
  const raw = source(); raw.Slots[0].Point = 0; raw.Effects[0].Level = 0;
  raw.Slots[0].Gems[0].Tooltip = tip(part('젬 기본 정보', '젬 포인트 : 0'), part('젬 효과', '혼돈 포인트 : 0<BR>필요 의지력 : 0'));
  const grid = mapped(raw), one = grid.cores[0].gems[0];
  assert.equal(grid.cores[0].points, 0); assert.equal(grid.effects[0].level, 0);
  assert.equal(one.points, 0); assert.equal(one.corePoints, 0); assert.equal(one.willpower, 0);
});

test('gem names and numeric summaries only use exact labelled tooltip fields', () => {
  const checks = [
    tip(part('다른 정보', '젬 포인트 : 15<BR>질서 포인트 : 5<BR>필요 의지력 : 3')),
    tip(part('젬 기본 정보', '젬 포인트 : 15<BR>젬 포인트 : 16'), part('젬 효과', '질서 포인트 : 5<BR>혼돈 포인트 : 4<BR>필요 의지력 : 3<BR>필요 의지력 : 2')),
    tip(part('젬 기본 정보', '젬 포인트 : 1,00'), part('젬 효과', '질서 포인트 : -1<BR>필요 의지력 : 3.5')),
    tip(part('젬 기본 정보', '젬 포인트 : 10001'), part('젬 효과', '질서 포인트 : 10001<BR>필요 의지력 : 10001')),
    'not JSON', 'x'.repeat(131073),
  ];
  for (const Tooltip of checks) {
    const one = mapped({ Slots: [{ ...core(), Gems: [{ ...gem(), Name: 'unofficial', Tooltip }] }] }).cores[0].gems[0];
    assert.equal(one.name, null); assert.equal(one.points, null); assert.equal(one.corePoints, null); assert.equal(one.willpower, null);
  }
  const ambiguous = tip({ type: 'NameTagBox', value: '첫째' }, { type: 'NameTagBox', value: '둘째' });
  assert.equal(mapped({ Slots: [{ ...core(), Gems: [{ ...gem(), Tooltip: ambiguous }] }] }).cores[0].gems[0].name, null);
});

test('all grid text, tooltips and official image URLs remain bounded and safe for text rendering', () => {
  const raw = source();
  raw.Slots[0].Name = '&lt;script&gt;private()&lt;/script&gt;<b>코어</b>';
  raw.Slots[0].Icon = 'https://cdn-lostark.game.onstove.com.evil.invalid/core.png';
  raw.Slots[0].Tooltip = tip(...Array.from({ length: 20 }, () => part('옵션', '공격력 +1% '.repeat(300))));
  raw.Slots[0].Gems[0].Icon = 'javascript:alert(1)';
  raw.Slots[0].Gems[0].Tooltip = tip({ type: 'NameTagBox', value: '<script>private()</script>' + '젬'.repeat(300) });
  raw.Effects[0].Tooltip = '<script>private()</script>' + '공격력 +1% '.repeat(300);
  const grid = mapped(raw);
  assert.equal(grid.cores[0].name, '코어'); assert.equal(grid.cores[0].icon, null);
  assert.equal(grid.cores[0].gems[0].icon, null); assert.equal(grid.cores[0].gems[0].name.length, 180);
  assert.equal(grid.cores[0].sections.length, 16); assert.equal(grid.cores[0].sections[0].entries[0].text.length, 1200);
  assert.equal(grid.effects[0].entries[0].truncated, true);
  assert.doesNotMatch(JSON.stringify(grid), /private\(\)|<script>|<b>|javascript:/);
});
