import test from 'node:test';
import assert from 'node:assert/strict';
import { mapCharacterSpecData } from '../src/character-spec-data.js';

const cdn = 'https://cdn-lostark.game.onstove.com/efui_iconatlas';
test('official unopened ArkGrid null pair is empty while missing or partial data stays unknown',()=>{
  assert.deepEqual(mapCharacterSpecData({arkgrid:{Slots:null,Effects:null}}).arkgrid,{cores:[],effects:[]});
  for(const arkgrid of [null,{}, {Slots:null}, {Slots:null,Effects:[]}, {Slots:[],Effects:null}]) {
    const result=mapCharacterSpecData({arkgrid}).arkgrid;
    assert.ok(result===null||result.effects===null);
  }
});
const part = (title, description) => ({ type: 'ItemPartBox', value: { Element_000: title, Element_001: description } });
const asTooltip = (...elements) => JSON.stringify(Object.fromEntries(elements.map((element, index) => [`Element_${String(index).padStart(3, '0')}`, element])));
const weapon = {
  Type: '무기', Name: '<FONT COLOR="#FA5D00">+20 운명의 결단</FONT>', Grade: '고대', Icon: `${cdn}/equipment.png`,
  Tooltip: asTooltip(
    { type: 'ItemTitle', value: { qualityValue: 100, leftStr2: '<FONT>아이템 레벨 1,780 (티어 4)</FONT>' } },
    part('기본 효과', '<FONT>무기 공격력 +65,421</FONT><BR>힘 +12,345'),
    part('추가 효과', '추가 피해 +30.00%'),
  ),
};
const necklace = {
  Type: '목걸이', Name: '겁화의 목걸이', Grade: '고대', Icon: `${cdn}/accessory.png`,
  Tooltip: asTooltip(
    { type: 'ItemTitle', value: { qualityValue: 97 } },
    part('연마 효과', '추가 피해 +2.60%<BR>적에게 주는 피해 +2.00%<BR>공격력 +195'),
    part('아크 패시브 포인트', '깨달음 +13'),
  ),
};
const bracelet = {
  Type: '팔찌', Name: '찬란한 팔찌', Grade: '고대',
  Tooltip: asTooltip(part('팔찌 효과', `<img src='${cdn}/bracelet_locked.png'>치명 +120<BR><img src='${cdn}/bracelet_locked.png'>힘 +12,000<BR>치명타 적중률이 3.40% 증가한다.<BR>공격 적중 시 8초 동안 공격력이 3.00% 증가한다.`)),
};
const stone = {
  Type: '어빌리티 스톤', Name: '숭고한 비상의 돌', Grade: '고대',
  Tooltip: asTooltip(part('기본 효과', '기본 체력 +7,804'), part('세공 단계 보너스', '기본 체력 +3,543'), {
    type: 'IndentStringGroup', value: { Element_000: { topStr: '세공 각인', contentStr: {
      Element_000: { contentStr: "[<FONT COLOR='#FFD200'>원한</FONT>] 활성도 <FONT>Lv.4</FONT>" },
      Element_001: { contentStr: "[<FONT COLOR='#FE2E2E'>공격력 감소</FONT>] 활성도 <FONT>Lv.1</FONT>" },
    } } },
  }),
};

test('official equipment separates slots and preserves effect lines and numeric values', () => {
  const result = mapCharacterSpecData({ equipment: [weapon, necklace, bracelet, stone] });
  assert.equal(result.equipment.length, 1);
  assert.equal(result.accessories.length, 1);
  assert.equal(result.equipment[0].name, '+20 운명의 결단');
  assert.equal(result.equipment[0].itemLevel, 1780);
  assert.equal(result.equipment[0].refinement, 20);
  assert.equal(result.equipment[0].quality, 100);
  assert.equal(result.accessories[0].quality, 97);
  assert.deepEqual(result.equipment[0].sections[0].entries.map((entry) => entry.text), ['무기 공격력 +65,421', '힘 +12,345']);
  assert.deepEqual(result.equipment[0].sections[0].entries[0].values, [{ value: 65421, unit: null }]);
  assert.deepEqual(result.accessories[0].sections[0].entries[0].values, [{ value: 2.6, unit: '%' }]);
  assert.deepEqual(result.accessories[0].sections[1].entries[0].values, [{ value: 13, unit: null }]);
  assert.equal(result.equipment[0].icon, weapon.Icon);
});

test('bracelet fixed stats, conditional effects, and stone reduction engraving remain separate', () => {
  const result = mapCharacterSpecData({ equipment: [bracelet, stone] });
  assert.deepEqual(result.bracelet.stats, [
    { name: '치명', value: 120, text: '치명 +120' }, { name: '힘', value: 12000, text: '힘 +12,000' },
  ]);
  assert.deepEqual(result.bracelet.effects[1].values, [{ value: 8, unit: '초' }, { value: 3, unit: '%' }]);
  assert.deepEqual(result.stone.engravings, [
    { name: '원한', level: 4, negative: false }, { name: '공격력 감소', level: 1, negative: true },
  ]);
  assert.equal(result.stone.sections.flatMap((section) => section.entries).some((entry) => entry.text.includes('공격력 감소')), true);
});

test('gems retain multiple skills for the same slot, zero slots, common and unmatched effects', () => {
  const result = mapCharacterSpecData({ gems: {
    Gems: [{ Slot: 0, Name: '<FONT>10레벨 겁화의 보석</FONT>', Level: 10, Grade: '고대', Icon: `${cdn}/gem.png` },
      { Slot: 1, Name: '9레벨 작열의 보석', Level: 9, Grade: '고대' }],
    Effects: { Description: '기본 공격력 +1.20%', Skills: [
      { GemSlot: 0, Name: '초신성 폭발', Description: ['피해가 44.00% 증가한다.'] },
      { GemSlot: 0, Name: '진 초신성 폭발', Description: ['피해가 44.00% 증가한다.', '아크 패시브 적용'] },
      { GemSlot: 1, Name: '죽음의 선고', Description: ['재사용 대기시간이 22.00% 감소한다.'] },
      { GemSlot: 99, Name: '이름이 남은 스킬', Description: ['추가 피해 +3.00%'] },
    ] },
  } }).gems;
  assert.equal(result.items[0].slot, 0);
  assert.equal(result.items[0].skills.length, 2);
  assert.equal(result.items[0].skills[1].effects.length, 2);
  assert.equal(result.items[1].skills[0].name, '죽음의 선고');
  assert.deepEqual(result.effects.map((entry) => entry.text), ['기본 공격력 +1.20%', '이름이 남은 스킬: 추가 피해 +3.00%']);
});

test('modern and legacy engravings retain level, stone contribution and exact descriptions', () => {
  const modern = mapCharacterSpecData({ engravings: { ArkPassiveEffects: [{ Name: '아드레날린', Level: 4,
    Grade: '유물', AbilityStoneLevel: 0, Description: '공격력 6% 증가<BR>치명타 적중률 20% 증가' }], Effects: [{ Name: '과거 각인' }] } }).engravings;
  assert.equal(modern.mode, 'arkpassive');
  assert.equal(modern.items[0].abilityStoneLevel, 0);
  assert.deepEqual(modern.items[0].effects.map((entry) => entry.text), ['공격력 6% 증가', '치명타 적중률 20% 증가']);
  const legacy = mapCharacterSpecData({ engravings: { ArkPassiveEffects: [], Effects: [{ Name: '원한 Lv.3', Description: '보스에게 주는 피해가 20% 증가한다.' }] } }).engravings;
  assert.equal(legacy.mode, 'legacy');
  assert.equal(legacy.items[0].level, 3);
});

test('Ark Passive points, tier, level and complete node effect clauses are preserved', () => {
  const result = mapCharacterSpecData({ arkpassive: {
    IsArkPassive: true, Points: [{ Name: '진화', Value: 140, Description: '전투 레벨 및 장비' }, { Name: '깨달음', Value: 0 }],
    Effects: [{ Name: '진화', Description: '<FONT>진화 4티어 뭉툭한 가시 Lv.2</FONT>', Icon: `${cdn}/ark.png`,
      ToolTip: asTooltip({ type: 'SingleTextBox', value: '진화형 피해가 15% 증가한다.<BR>치명타가 발생할 확률이 최대 80%로 제한된다.<BR>초과한 치명타 확률의 150%가 진화형 피해로 전환된다.<BR>이 노드에 의한 진화형 피해는 최대 75% 증가한다.' }) }],
  } }).arkpassive;
  assert.equal(result.isEnabled, true);
  assert.equal(result.points[1].value, 0);
  assert.equal(result.effects[0].category, '진화');
  assert.equal(result.effects[0].name, '뭉툭한 가시');
  assert.equal(result.effects[0].tier, 4);
  assert.equal(result.effects[0].level, 2);
  assert.deepEqual(result.effects[0].effects.flatMap((entry) => entry.values.map((value) => value.value)), [15, 80, 150, 75]);
});

test('missing and malformed sections remain unavailable, valid empty lists stay empty', () => {
  for (const input of [undefined, null, [], {}, { equipment: 'wrong', gems: [], engravings: false, arkpassive: 1 }]) {
    assert.deepEqual(mapCharacterSpecData(input), { equipment: null, accessories: null, bracelet: null, stone: null, gems: null, engravings: null, arkpassive: null, cards: null, arkgrid: null });
  }
  assert.equal(mapCharacterSpecData({ equipment: [null, 'wrong', {}] }).equipment, null);
  assert.equal(mapCharacterSpecData({ gems: { Gems: [null] } }).gems, null);
  const empty = mapCharacterSpecData({ equipment: [], gems: { Gems: [] }, engravings: { Effects: [] }, arkpassive: { IsArkPassive: false } });
  assert.deepEqual(empty.equipment, []);
  assert.deepEqual(empty.gems.items, []);
  assert.deepEqual(empty.engravings.items, []);
  assert.equal(empty.arkpassive.isEnabled, false);
  assert.equal(empty.stone, null);
  for (const raw of ['null', '[]', 'true', '{', 'x'.repeat(131073)]) {
    const item = mapCharacterSpecData({ equipment: [{ Type: '무기', Name: '시험용 무기', Tooltip: raw }] }).equipment[0];
    assert.equal(item.quality, null);
    assert.deepEqual(item.sections, []);
  }
});

test('HTML and unsafe icon URLs never become markup or navigation data', () => {
  for (const url of ['javascript:alert(1)', 'http://cdn-lostark.game.onstove.com/a.png',
    'https://cdn-lostark.game.onstove.com.evil.example/a.png', 'https://maintainer@example.com/a.png',
    'https://cdn-lostark.game.onstove.com:8443/a.png', 'https://cdn-lostark.game.onstove.com/a.svg']) {
    const mapped = mapCharacterSpecData({ equipment: [{ ...weapon, Icon: url, Name: '&lt;script&gt;alert(1)&lt;/script&gt;안전한 무기',
      Tooltip: asTooltip(part('<img src=x onerror=alert(1)>기본 효과', '<script>alert(1)</script>공격력 +10<br>&#60;img src=x onerror=alert(1)&#62;추가 피해 +2%')) }] });
    assert.equal(mapped.equipment[0].icon, null);
    assert.equal(mapped.equipment[0].name, '안전한 무기');
    assert.equal(JSON.stringify(mapped).includes('<'), false);
    assert.equal(JSON.stringify(mapped).includes('alert(1)'), false);
  }
});

test('arrays, tooltip input, strings and extracted values have bounded output', () => {
  const oversized = 'x'.repeat(131073);
  const mapped = mapCharacterSpecData({ equipment: Array.from({ length: 100 }, () => ({ ...weapon,
    Name: '긴'.repeat(20000), Tooltip: oversized })),
  gems: { Gems: Array.from({ length: 100 }, (_, Slot) => ({ Slot, Name: '보석', Level: 'Infinity' })) } });
  assert.equal(mapped.equipment.length, 32);
  assert.equal(mapped.equipment[0].name.length, 180);
  assert.deepEqual(mapped.equipment[0].sections, []);
  assert.equal(mapped.gems.items.length, 16);
  assert.equal(mapped.gems.items[0].level, null);
  const line = mapCharacterSpecData({ equipment: [{ ...weapon, Tooltip: asTooltip(part('효과', '공격력 +1% '.repeat(300))) }] }).equipment[0].sections[0].entries[0];
  assert.equal(line.text.length, 1200);
  assert.equal(line.values.length, 12);
  assert.equal(line.truncated, true);
  const manySections = mapCharacterSpecData({ equipment: [{ ...weapon,
    Tooltip: asTooltip(...Array.from({ length: 20 }, () => part('효과', Array.from({ length: 40 }, () => '공격력 +1%').join('<br>')))),
  }] }).equipment[0].sections;
  assert.equal(manySections.length, 16);
  assert.equal(manySections[0].entries.length, 32);
});

test('mapping does not modify official response objects or invent unknown numeric values', () => {
  const input = { equipment: [weapon, { Type: '부적', Name: '보조 장비', Tooltip: asTooltip({ type: 'ItemTitle', value: { qualityValue: 101 } }) }] };
  const before = JSON.stringify(input);
  const output = mapCharacterSpecData(input);
  assert.equal(JSON.stringify(input), before);
  assert.equal(output.equipment[1].quality, null);
  assert.equal(output.equipment[1].itemLevel, null);
  assert.equal(output.equipment[1].refinement, null);
});

test('literal comparison operators survive HTML removal in effect clauses', () => {
  const output = mapCharacterSpecData({ equipment: [{ ...weapon,
    Tooltip: asTooltip(part('조건', '치적 &lt; 80%, 체력 &gt; 20%일 때 추가 피해 +2.00%')),
  }] });
  assert.equal(output.equipment[0].sections[0].entries[0].text, '치적 < 80%, 체력 > 20%일 때 추가 피해 +2.00%');
});

test('official Ark Passive MultiTextBox separators create effect lines without empty tails', () => {
  const output = mapCharacterSpecData({ arkpassive: { IsArkPassive: true, Points: [], Effects: [{
    Name: '깨달음', Description: '깨달음 1티어 기력 회복 Lv.3',
    ToolTip: asTooltip({ type: 'NameTagBox', value: '기력 회복' }, { type: 'MultiTextBox',
      value: "기력 에너지의 자연 회복 속도가 <FONT COLOR='#99ff99'>600.0%</FONT> 증가한다.||<BR>치적 &lt; 80%, 체력 &gt; 20%일 때 추가 피해 +2.00%||" }),
  }] } }).arkpassive.effects[0].effects;
  assert.deepEqual(output.map((effect) => effect.text), [
    '기력 회복', '기력 에너지의 자연 회복 속도가 600.0% 증가한다.', '치적 < 80%, 체력 > 20%일 때 추가 피해 +2.00%',
  ]);
  assert.deepEqual(output[1].values, [{ value: 600, unit: '%' }]);
  assert.deepEqual(output[2].values, [{ value: 80, unit: '%' }, { value: 20, unit: '%' }, { value: 2, unit: '%' }]);
});

test('malformed comma grouping never becomes a quality, point or effect number', () => {
  const output = mapCharacterSpecData({
    equipment: [
      { ...weapon, Tooltip: asTooltip({ type: 'ItemTitle', value: { qualityValue: 0 } },
        part('효과', '공격력 +1,,2<BR>공격력 +1,2<BR>추가 피해 +1,234.50%<BR>추가 피해 +0.00%')) },
      { Type: '투구', Name: '시험용 투구', Tooltip: asTooltip({ type: 'ItemTitle', value: { qualityValue: '1,,2' } }) },
    ],
    arkpassive: { Points: [{ Name: '진화', Value: '1,,2' }, { Name: '깨달음', Value: '1,2' },
      { Name: '유효한 쉼표', Value: '1,234.50' }, { Name: '영점', Value: 0 }], Effects: [] },
  });
  assert.equal(output.equipment[0].quality, 0);
  assert.equal(output.equipment[1].quality, null);
  assert.deepEqual(output.arkpassive.points.map((point) => point.value), [null, null, 1234.5, 0]);
  const effects = output.equipment[0].sections[0].entries;
  assert.deepEqual(effects.map((effect) => effect.values), [[], [], [{ value: 1234.5, unit: '%' }], [{ value: 0, unit: '%' }]]);
  assert.equal(effects[0].text, '공격력 +1,,2');
});
