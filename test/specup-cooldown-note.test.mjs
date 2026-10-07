import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { footerFor, kakaoTexts, COOLDOWN_ASSUMPTION } from '../src/specup-view.js';

// 쿨감(작열) 보석의 딜 상승률은 그 스킬을 쿨타임마다 쓴다고 가정해 계산한다(src/gem-model.js cooldownUse 1).
// 모델로 계산한 쿨감 후보가 있을 때만 그 가정을 봇 푸터·카톡 본문·홈페이지 계산 기준에 같은 문장으로 적는다.
const NOTE = '쿨감 보석은 스킬을 쿨타임마다 쓴다고 가정';
const gemRow = (type, gainSource = 'model') => ({
  kind: '보석', option: `블레이드 버스트 · 7레벨 ${type === '피해' ? '겁화' : '작열'} → 8레벨 ${type === '피해' ? '겁화' : '작열'}`,
  gainPercent: 0.8, gainSource, finalScore: 1250, expectedCost: 300_000, per100k: 0.27, priceSource: 'api',
  gem: { skill: '블레이드 버스트', type, from: 7, to: 8 },
});
const guide = rows => ({ baseScore: 1234.5, pricedAt: Date.parse('2026-09-23T12:00:00+09:00'), priceStale: false,
  droppedForPrice: 0, crystalPrice95: 17_000, rows });
const CASES = [
  ['모델로 계산한 쿨감 후보', [gemRow('쿨감'), gemRow('피해')], true],
  ['피해 보석만', [gemRow('피해')], false],
  ['로펙 비율로 대체된 쿨감 후보', [gemRow('쿨감', 'lopec')], false],
  ['보석 없음', [{ kind: '악세', option: '목걸이 · 교체', gainPercent: 0.5, gainSource: 'lopec', finalScore: 1240, expectedCost: 100_000, per100k: 0.5, priceSource: 'api' }], false],
];

test('봇 푸터와 카톡 본문은 모델로 계산한 쿨감 후보가 있을 때만 쿨감 가정을 적는다', () => {
  assert.equal(COOLDOWN_ASSUMPTION, NOTE);
  const profile = { CharacterName: '합성캐릭터4', CharacterClassName: '블레이드', ItemAvgLevel: '1,775.00' };
  for (const [label, rows, expected] of CASES) {
    const footer = footerFor(guide(rows));
    assert.equal(footer.split(' · ').includes(NOTE), expected, `${label}: 디스코드 푸터`);
    const { preview, full } = kakaoTexts(profile, guide(rows));
    for (const text of [preview, full]) assert.equal(text.split('\n').includes(NOTE), expected, `${label}: 카톡 본문`);
  }
});

// 홈페이지(docs/spec-specup.js)는 봇 응답의 푸터를 받지 않고 같은 행 자료로 계산 기준을 직접 만든다.
// 그 함수를 원문 그대로 떼어 실행해 봇과 같은 문장·같은 조건인지 확인한다.
test('홈페이지 계산 기준도 같은 조건에서 같은 문장을 적는다', () => {
  const source = fs.readFileSync(new URL('../docs/spec-specup.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('    function footerNotes(answer) {');
  const end = source.indexOf('\n    }\n', start);
  assert.ok(start > 0 && end > start, '홈페이지 footerNotes를 찾는다');
  const footerNotes = new Function('gold', 'clock', 'monthDay', `${source.slice(start, end + 6)}\nreturn footerNotes;`)(
    n => `${n} G`, () => '12:00', () => '9/23');
  for (const [label, rows, expected] of CASES) {
    const notes = footerNotes({ guide: guide(rows), crystal: null, finishedAt: Date.parse('2026-09-23T12:00:00+09:00') });
    assert.equal(notes.includes(NOTE), expected, `${label}: 홈페이지`);
  }
});
