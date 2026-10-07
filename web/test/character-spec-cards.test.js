import test from 'node:test';
import assert from 'node:assert/strict';
import { mapCharacterSpecData } from '../src/character-spec-data.js';

const image = 'https://cdn-lostark.game.onstove.com/efui_iconatlas/card/card_1.png';
const card = (Slot = 0) => ({ Slot, Name: '니나브', Icon: image, Grade: '전설', AwakeCount: 5, AwakeTotal: 5 });
const source = () => ({ Cards: [card(0), { ...card(1), Name: '샨디', AwakeCount: 0 }], Effects: [
  { Index: 0, CardSlots: [0, 1], Items: [
    { Name: '세상을 구하는 빛 2세트', Description: '암속성 피해 감소 <FONT>+10.00%</FONT>' },
    { Name: '세상을 구하는 빛 6세트 (30각성합계)', Description: '성속성 피해 <FONT>+8.00%</FONT><BR>공격 속성은 성속성으로 변환됩니다.' },
  ] },
] });

test('cards keep official slots, portrait icons, awakening and every active set effect in source order', () => {
  const raw = source(), before = structuredClone(raw);
  const mapped = mapCharacterSpecData({ cards: raw }).cards;
  assert.deepEqual(mapped.items, [
    { slot: 0, name: '니나브', icon: image, grade: '전설', awakeCount: 5, awakeTotal: 5 },
    { slot: 1, name: '샨디', icon: image, grade: '전설', awakeCount: 0, awakeTotal: 5 },
  ]);
  assert.deepEqual(mapped.sets[0].cardSlots, [0, 1]);
  assert.equal(mapped.sets[0].index, 0);
  assert.equal(mapped.sets[0].items.at(-1).name, '세상을 구하는 빛 6세트 (30각성합계)');
  assert.deepEqual(mapped.sets[0].items[1].effects.map(item => item.text), ['성속성 피해 +8.00%', '공격 속성은 성속성으로 변환됩니다.']);
  assert.deepEqual(mapped.sets[0].items[0].effects[0].values, [{ value: 10, unit: '%' }]);
  assert.deepEqual(raw, before);
});

test('absent cards differ from an explicitly empty loadout, while malformed or excessive sections fail closed', () => {
  assert.equal(mapCharacterSpecData({}).cards, null);
  assert.deepEqual(mapCharacterSpecData({ cards: { Cards: [], Effects: [] } }).cards, { items: [], sets: [] });
  for (const raw of [null, [], {}, { Cards: null, Effects: [] }, { Cards: [], Effects: null },
    { Cards: [null], Effects: [] }, { Cards: [card(0), card(0)], Effects: [] },
    { Cards: Array.from({ length: 17 }, (_, i) => card(i)), Effects: [] },
    { Cards: [card()], Effects: [{ Index: 0, CardSlots: [0, 0], Items: [] }] },
    { Cards: [card()], Effects: [{ Index: 0, CardSlots: ['0'], Items: [] }] },
    { Cards: [card()], Effects: [{ Index: 0, CardSlots: [0], Items: [null] }] },
    { Cards: [card()], Effects: [{ Index: 0, CardSlots: [0], Items: Array.from({ length: 17 }, () => ({ Name: '효과' })) }] },
  ]) assert.equal(mapCharacterSpecData({ cards: raw }).cards, null);
});

test('unknown awakening values do not become zero and invalid count/maximum pairs are not displayed as valid', () => {
  for (const value of [undefined, null, '', '5', false, NaN, Infinity, -1, 1.5, 101]) {
    const mapped = mapCharacterSpecData({ cards: { Cards: [{ ...card(), AwakeCount: value }], Effects: [] } }).cards;
    assert.equal(mapped.items[0].awakeCount, null);
    assert.equal(mapped.items[0].awakeTotal, 5);
  }
  const impossible = mapCharacterSpecData({ cards: { Cards: [{ ...card(), AwakeCount: 6 }], Effects: [] } }).cards.items[0];
  assert.equal(impossible.awakeCount, null); assert.equal(impossible.awakeTotal, null);
});

test('card strings, effect clauses and image URLs use existing bounded plain-text normalization', () => {
  const raw = source();
  raw.Cards[0].Name = '&lt;script&gt;private()&lt;/script&gt;<b>니나브</b>';
  raw.Cards[0].Icon = 'https://cdn-lostark.game.onstove.com.evil.invalid/card.png';
  raw.Cards[1].Icon = 'javascript:alert(1)';
  raw.Effects[0].Items[0].Description = '<script>private()</script>공격력 +1% '.repeat(300);
  const mapped = mapCharacterSpecData({ cards: raw }).cards;
  assert.equal(mapped.items[0].name, '니나브');
  assert.equal(mapped.items[0].icon, null); assert.equal(mapped.items[1].icon, null);
  const effect = mapped.sets[0].items[0].effects[0];
  assert.ok(effect.text.length <= 1200); assert.equal(effect.truncated, true);
  assert.doesNotMatch(JSON.stringify(mapped), /private\(\)|<script>|<b>/);
});

const tooltip = (...parts) => JSON.stringify(Object.fromEntries(parts.map((value, i) => [`Element_${i}`, value])));
const part = (title, text) => ({ type: 'ItemPartBox', value: { Element_000: title, Element_001: text } });

test('elixir and transcendence are explicit source sections, with original equipment details preserved', () => {
  const raw = { Type: '투구', Name: '+21 시험 투구', Grade: '고대', Icon: image, Tooltip: tooltip(
    part('기본 효과', '힘 +120'),
    part('<FONT>엘릭서 효과</FONT>', '공격력 Lv.5<BR>회심 (질서) Lv.5'),
    { type: 'IndentStringGroup', value: { Element_000: { topStr: '[초월] 7단계', contentStr: {
      Element_000: { contentStr: '초월 포인트 21<BR>힘 +4200' },
    } } } },
  ) };
  const before = structuredClone(raw), item = mapCharacterSpecData({ equipment: [raw] }).equipment[0];
  assert.equal(item.refinement, 21); assert.equal(item.sections.length, 3);
  assert.equal(item.enhancements.elixir[0].title, '엘릭서 효과');
  assert.deepEqual(item.enhancements.elixir[0].entries.map(row => row.text), ['공격력 Lv.5', '회심 (질서) Lv.5']);
  assert.equal(item.enhancements.transcendence[0].title, '[초월] 7단계');
  assert.deepEqual(item.enhancements.transcendence[0].entries.map(row => row.text), ['초월 포인트 21', '힘 +4200']);
  assert.deepEqual(raw, before);
});

test('missing or unreadable enhancement sections remain unknown; mentions inside unrelated effects are not treated as upgrades', () => {
  for (const Tooltip of [undefined, 'broken', '{}', tooltip(part('장비 효과', '엘릭서 효과는 이 장비에 적용되지 않습니다.'))]) {
    const item = mapCharacterSpecData({ equipment: [{ Type: '무기', Name: '시험 무기', Tooltip }] }).equipment[0];
    assert.deepEqual(item.enhancements, { elixir: null, transcendence: null });
  }
});
