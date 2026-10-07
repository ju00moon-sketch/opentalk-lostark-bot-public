import test from 'node:test';
import assert from 'node:assert/strict';
import { createBraceletValueService } from '../src/bracelet-value.js';
import { analyzeBraceletExpectation } from '../../src/character-bracelet-expectation.js';

const config = { automaticApproval: { lostArkApiKey: 'test-key' } };
const unavailable = { status: 'unavailable', reason: '고정 옵션만 있는 효과 부여 불가 팔찌는 효과 변환 기댓값을 계산하지 않습니다.' };
const detail = expectation => ({ efficiency: { source: 'official-api', characterName: '시험캐릭터', bracelet: { status: 'unavailable', omitted: ['unrelated baseline unavailable'] }, braceletExpectation: expectation } });

test('a verified official unsupported target returns its explanation without an auction request', async t => {
  let calls = 0;
  const app = createBraceletValueService({ config, readDetails: async () => detail(unavailable), fetchImpl: async () => { calls++; throw new Error('unexpected'); } });
  t.after(() => app.close());
  const actual = await app.get('시험캐릭터');
  assert.equal(actual.status, 'unavailable'); assert.equal(actual.reason, unavailable.reason);
  assert.equal(actual.costExpectedGold, null); assert.equal(actual.price, null); assert.equal(calls, 0);
});

test('independent expectation and auction results survive an unavailable efficiency baseline', async t => {
  const fixed = ['치명 +83', '특화 +90'].map(text => `<img src='emoticon_tooltip_bracelet_locked'></img>${text}`);
  const granted = ['민첩 +12000', '체력 +4000'].map(text => `<img src='emoticon_tooltip_bracelet_changeable'></img>${text}`);
  const item = { Type: '팔찌', Grade: '고대', Tooltip: JSON.stringify({
    title: { type: 'ItemTitle', value: { leftStr2: '아이템 티어 4' } },
    effects: { type: 'ItemPartBox', value: { Element_000: '팔찌 효과', Element_001: [...fixed, ...granted].join('<BR>') } },
  }) };
  const expectation = analyzeBraceletExpectation({ ArmoryEquipment: [item] });
  assert.equal(expectation.status, 'ok'); let calls = 0;
  const app = createBraceletValueService({ config, readDetails: async () => detail(expectation), fetchImpl: async () => {
    calls++; return new Response(JSON.stringify({ PageNo: 1, PageSize: 10, TotalCount: 0, Items: [] }), { headers: { 'Content-Type': 'application/json' } });
  } });
  t.after(() => app.close());
  const actual = await app.get('시험캐릭터');
  assert.equal(actual.status, 'no_listings'); assert.equal(calls, 1);
  assert.ok(actual.expectedStartingBracelets > 0); assert.equal(actual.costExpectedGold, null);
});

test('unverified identity cannot return a caller-visible unsupported explanation', async t => {
  const app = createBraceletValueService({ config, readDetails: async () => ({ efficiency: { ...detail(unavailable).efficiency, characterName: '다른캐릭터' } }) });
  t.after(() => app.close());
  await assert.rejects(app.get('시험캐릭터'), { status: 502 });
});
