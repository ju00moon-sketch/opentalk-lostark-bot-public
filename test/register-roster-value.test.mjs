import test from 'node:test';
import assert from 'node:assert/strict';
import { startRosterValue, REFRESH_NOTE } from '../src/commands/register.js';

// /등록 직후 그 이름만 홈페이지에 계산 요청을 보낸다 (README.md).
test('등록은 그 캐릭터 하나만 계산 요청하고 실패해도 등록을 막지 않는다', async () => {
  const sent = [];
  assert.equal(await startRosterValue('앞으로가나', async (names) => { sent.push(names); return { status: 'started' }; }), true);
  assert.deepEqual(sent, [['앞으로가나']]);
  // 이미 돌고 있으면 홈페이지가 대기열에 넣고 running으로 답한다 — 그래도 시작된 것으로 안내한다.
  assert.equal(await startRosterValue('앞으로가나', async () => ({ status: 'running' })), true);
  assert.equal(await startRosterValue('앞으로가나', async () => null), false);
  assert.equal(await startRosterValue('앞으로가나', async () => { throw new Error('연결 실패'); }), false);
});

test('등록 안내 문구는 계산 시작과 확인 시점을 알려 준다', () => {
  assert.match(REFRESH_NOTE, /1~3분 뒤/);
  assert.match(REFRESH_NOTE, /환산가치/);
  // 카카오톡에는 마크다운이 없으므로 백틱을 뺀 문장이 그대로 읽혀야 한다.
  assert.equal(REFRESH_NOTE.replaceAll('`', ''), '환산 가치 계산을 시작했어요. 1~3분 뒤 /환산가치에서 확인해 주세요.');
});
