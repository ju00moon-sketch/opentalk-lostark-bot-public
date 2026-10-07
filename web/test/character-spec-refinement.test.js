import test from 'node:test';
import assert from 'node:assert/strict';
import { mapCharacterSpecData } from '../src/character-spec-data.js';

const part = (title, text) => ({ type: 'ItemPartBox', value: { Element_000: title, Element_001: text } });
const accessory = (type, text, extra = []) => ({ Type: type, Name: `시험 ${type}`, Grade: '고대',
  Tooltip: JSON.stringify(Object.fromEntries([part('연마 효과', text), ...extra].map((value, index) => [`Element_${index}`, value]))) });
const options = (type, text) => mapCharacterSpecData({ equipment: [accessory(type, text)] }).accessories[0].refinementOptions;

test('necklace summary uses known grades while preserving actual numeric source text', () => {
  const result = options('목걸이', "<img src='emoticon_sign_greenDot'>적에게 주는 피해 <FONT color='FE9600'>+2.00%</FONT><br>추가 피해 +0.70%<br>공격력 +390");
  assert.deepEqual(result.map(({ shortName, grade, value, unit, text }) => ({ shortName, grade, value, unit, text })), [
    { shortName: '적주피', grade: '상', value: 2, unit: '%', text: '적에게 주는 피해 +2.00%' },
    { shortName: '추피', grade: '하', value: 0.7, unit: '%', text: '추가 피해 +0.70%' },
    { shortName: '공', grade: '상', value: 390, unit: null, text: '공격력 +390' },
  ]);
  assert.deepEqual(options('목걸이', '적에게 주는 피해 +2.00%<br>추가 피해 +2.60%<br>공격력 +80')
    .map(row => `${row.shortName} ${row.grade}`), ['적주피 상', '추피 상', '공 하']);
});

test('percent and flat attack use different option identities and exact values', () => {
  const result = options('귀걸이', '공격력 +1.55%<br>공격력 +195<br>무기 공격력 +1.80%<br>무기 공격력 +480');
  assert.deepEqual(result.map(row => [row.optionCode, row.shortName, row.grade]), [
    [45, '공%', '상'], [53, '공', '중'], [46, '무공%', '중'], [54, '무공', '중'],
  ]);
  const ring = options('반지', '치명타 적중률 +0.95%<br>최대 생명력 +1,300<br>치명타 피해 +4.00%');
  assert.deepEqual(ring.map(row => [row.shortName, row.grade]), [['치적', '중'], ['최생', '하'], ['치피', '상']]);
});

test('support and shared options follow existing published grinding values', () => {
  assert.deepEqual(options('목걸이', '낙인력 +8.00%<br>세레나데, 신앙, 조화 게이지 획득량 +3.60%').map(row => row.grade), ['상', '중']);
  assert.deepEqual(options('귀걸이', '파티원 회복 효과 +2.10%<br>파티원 보호막 효과 +0.95%').map(row => row.grade), ['중', '하']);
  assert.deepEqual(options('반지', '아군 공격력 강화 효과 +5.00%<br>아군 피해량 강화 효과 +4.50%').map(row => row.grade), ['상', '중']);
  assert.deepEqual(options('귀걸이', '최대 마나 +15<br>상태이상 공격 지속시간 +0.50%<br>전투 중 생명력 회복량 +50').map(row => row.grade), ['중', '중', '상']);
});

test('unknown values, names, units and wrong slots never receive guessed grades', () => {
  for (const [type, text] of [['목걸이', '적에게 주는 피해 +1.99%'], ['목걸이', '치명타 적중률 +0.95%'],
    ['귀걸이', '공격력 +1.55'], ['반지', '이동 속도 +10%'], ['목걸이', '적에게 주는 피해 +2.00000001%'],
    ['목걸이', '공격력 -80'], ['목걸이', '공격력 +1,,300'], ['목걸이', '공격력 +0']]) {
    const [result] = options(type, text);
    assert.equal(result.grade, null, text); assert.equal(result.text, text);
  }
  assert.equal(options('귀걸이', '공격력 +1.5500%')[0].grade, '상');
});

test('only actual accessory refinement sections are classified, with missing data distinct from no options', () => {
  const result = mapCharacterSpecData({ equipment: [
    { Type: '완갑', Name: '+20 운명의 전율 완갑', Tooltip: '{}' },
    { Type: '목걸이', Name: '시험 목걸이', Tooltip: JSON.stringify({ a: part('기본 효과', '공격력 +80') }) },
    accessory('반지', '치명타 피해 +4.00%', [part('기본 효과', '공격력 +80'), part('설명', '적에게 주는 피해 +2.00%')]),
  ] });
  assert.equal(result.equipment[0].type, '완갑');
  assert.equal(result.accessories[0].refinementOptions, null);
  assert.equal(result.accessories[1].refinementOptions.length, 1);
  assert.equal(result.accessories[1].sections.length, 3);
  assert.equal(Object.hasOwn(result.equipment[0], 'refinementOptions'), false);
});
