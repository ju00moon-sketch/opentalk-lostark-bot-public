import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createSiteSpecup, isSpecupName, SPECUP_SITE_PATH } from '../src/specup-site.js';
import { startKakaoServer } from '../src/kakao/server.js';
import { listenOnFreePort } from './helpers/free-port.mjs';

// 홈페이지 캐릭터 화면이 읽는 스펙업 판. 계산은 /스펙업과 같은 코어를 지나가고, 이 경로는 기다리지 않는다.
const guide = (rows = 1) => ({
  baseScore: 1234.5, pricedAt: Date.parse('2026-09-21T12:00:00+09:00'), priceStale: false,
  droppedForPrice: 2, crystalPrice95: 17_000,
  rows: Array.from({ length: rows }, (value, index) => ({
    kind: '보석', option: `페이탈 웨이브 · ${7 + index}레벨 겁화 → ${8 + index}레벨 겁화`,
    gainPercent: 0.98, gainSource: 'model', finalScore: 1246.6, expectedCost: 360_000, per100k: 0.27,
    priceSource: 'api', cells: ['버려질 값'], gem: { skill: '페이탈 웨이브', type: '피해', from: 7, to: 8 },
  })),
});
const crystal = { price95: 17_000, at: Date.parse('2026-09-21T08:00:00+09:00'), by: '로아툴', source: 'auto' };
const store = (value = crystal) => ({ get: () => value });

// 계산이 끝나는 시점을 시험이 정한다.
function deferred() {
  let settle;
  const promise = new Promise((resolve) => { settle = resolve; });
  return { promise, settle };
}

// 빈 포트를 찾아 바로 붙잡는다. KAKAO_PORT는 0을 "꺼짐"으로 읽으므로 번호를 먼저 알아내야 하는데,
// 그 사이 다른 시험이 같은 번호를 채 갈 수 있다. 서버가 못 올라오면 다른 번호로 다시 시도한다.
const startOnFreePort = (env) =>
  listenOnFreePort((port) => startKakaoServer(new Map(), { ...env, KAKAO_PORT: String(port) }));

test('이름 규칙은 캐릭터명만 받는다', () => {
  for (const name of ['합성캐릭터4', 'ab', '가'.repeat(12)]) assert.equal(isSpecupName(name), true, name);
  for (const name of ['가', '가'.repeat(13), '블레 상돈', '블레/99', '', null, 42]) assert.equal(isSpecupName(name), false, String(name));
});

test('같은 이름을 여러 번 물어도 계산은 한 번이고 셋 다 계산 중을 받는다', async () => {
  const job = deferred();
  let calls = 0, passed = null;
  const site = createSiteSpecup({
    getGuide: (name, options) => { calls += 1; passed = { name, options }; return job.promise; },
    store: store(), now: () => 1000,
  });
  const first = site.request('합성캐릭터4');
  assert.equal(first.status, 'running');
  assert.equal(first.name, '합성캐릭터4');
  assert.equal(first.startedAt, 1000);
  assert.equal(site.request('합성캐릭터4').status, 'running');
  assert.equal(site.request('합성캐릭터4').status, 'running');
  assert.equal(calls, 1, '계산은 한 번만 걸린다');
  assert.deepEqual(passed, { name: '합성캐릭터4', options: { crystalPrice95: 17_000 } });

  job.settle(guide(2));
  await job.promise;
  await Promise.resolve();
  const done = site.request('합성캐릭터4');
  assert.equal(done.status, 'done');
  assert.equal(calls, 1, '끝난 판은 코어를 다시 부르지 않는다');
  assert.equal(done.guide.rows.length, 2);
  assert.equal(done.guide.baseScore, 1234.5);
  assert.equal(done.guide.droppedForPrice, 2);
  assert.deepEqual(done.guide.rows[0].gem, { skill: '페이탈 웨이브', type: '피해', from: 7, to: 8 });
  assert.equal('cells' in done.guide.rows[0], false, '코어 내부 값은 내보내지 않는다');
  assert.deepEqual(done.crystal, { price95: 17_000, at: crystal.at, source: 'auto' });
  assert.equal('by' in done.crystal, false, '시세를 적은 사람 이름은 내보내지 않는다');
});

test('끝난 판은 5분이 지나면 버리고 다시 계산한다', async () => {
  let clock = 1000, calls = 0;
  const site = createSiteSpecup({ getGuide: () => { calls += 1; return Promise.resolve(guide()); }, store: store(), now: () => clock });
  site.request('합성캐릭터4');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(site.request('합성캐릭터4').status, 'done');
  clock += 4 * 60 * 1000;
  assert.equal(site.request('합성캐릭터4').status, 'done');
  assert.equal(calls, 1);
  clock += 60 * 1000 + 1;
  assert.equal(site.request('합성캐릭터4').status, 'running', '5분이 지나면 새로 계산한다');
  assert.equal(calls, 2);
});

test('홈페이지 몫을 넘기면 코어를 부르지 않고 busy로 돌려보낸다', () => {
  const job = deferred();
  let calls = 0;
  const site = createSiteSpecup({ getGuide: () => { calls += 1; return job.promise; }, store: store(), now: () => 1000, maxActive: 3 });
  for (const name of ['합성캐릭터4', '합성캐릭터3', '합성캐릭터2']) assert.equal(site.request(name).status, 'running');
  assert.deepEqual(site.request('합성원정대'), { status: 'busy' });
  assert.equal(calls, 3, '넷째는 봇의 대기줄에 서지 않는다');
  // 이미 걸어 둔 이름은 상한과 무관하게 그 상태를 그대로 받는다.
  assert.equal(site.request('합성캐릭터3').status, 'running');
  job.settle(null);
});

test('코어가 계산하지 못하면 unavailable, 후보가 없으면 빈 판의 done', async () => {
  const empty = createSiteSpecup({ getGuide: () => Promise.resolve(null), store: store(null), now: () => 1000 });
  empty.request('합성캐릭터4');
  await new Promise((resolve) => setImmediate(resolve));
  const failed = empty.request('합성캐릭터4');
  assert.equal(failed.status, 'unavailable');
  assert.equal('guide' in failed, false);

  const none = createSiteSpecup({ getGuide: () => Promise.resolve(guide(0)), store: store(null), now: () => 1000 });
  none.request('합성캐릭터4');
  await new Promise((resolve) => setImmediate(resolve));
  const board = none.request('합성캐릭터4');
  assert.equal(board.status, 'done');
  assert.deepEqual(board.guide.rows, []);
  assert.equal(board.crystal, null, '크리스탈 시세가 없으면 null이고 페온은 빠진다');
});

test('코어가 예외를 던져도 계산 중으로 남지 않는다', async () => {
  const noisy = [];
  const original = console.error;
  console.error = (...parts) => noisy.push(parts.join(' '));
  try {
    const site = createSiteSpecup({ getGuide: () => Promise.reject(new Error('로펙 응답 깨짐')), store: store(), now: () => 1000 });
    site.request('합성캐릭터4');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(site.request('합성캐릭터4').status, 'unavailable');
  } finally { console.error = original; }
  assert.equal(noisy.some((line) => line.includes('로펙 응답 깨짐')), true);
});

test('봇 경로는 루프백 + 토큰일 때만 답하고 잘못된 이름은 거절한다', async (t) => {
  const token = 'd'.repeat(40);
  const { server, port } = await startOnFreePort({
    KAKAO_SKILL_SECRET: 'test-secret', PUBLIC_BASE_URL: 'http://127.0.0.1',
    BOT_INTERNAL_TOKEN: token,
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const call = (query = '?name=합성캐릭터4', options = {}) => fetch(`http://127.0.0.1:${port}${SPECUP_SITE_PATH}${query}`, options);

  assert.equal((await call()).status, 404, '토큰 없이는 모르는 경로처럼 답한다');
  assert.equal((await call('?name=합성캐릭터4', { headers: { 'X-Bot-Token': 'e'.repeat(40) } })).status, 404);
  const headers = { 'X-Bot-Token': token };
  assert.equal((await call('', { headers })).status, 400, '이름이 없으면 거절한다');
  assert.equal((await call('?name=블레/99', { headers })).status, 400);
  assert.equal((await call('?name=합성캐릭터4&scope=roster', { headers })).status, 400, '모르는 질의는 받지 않는다');
  const rejected = await call('?name=합성캐릭터4', { method: 'POST', headers });
  assert.equal(rejected.status, 405);
  assert.equal(rejected.headers.get('allow'), 'GET');
});

test('빈 포트 헬퍼는 EADDRINUSE에서 다시 시도하고 다른 오류는 그대로 올린다', async () => {
  const { EventEmitter } = await import('node:events');
  const fake = () => {
    const server = new EventEmitter();
    server.close = (done) => done?.();
    return server;
  };
  // 첫 시도만 포트 경쟁으로 실패하고 두 번째가 성공해야 한다(예전 Promise.race 판은 1회에서 멈췄다).
  let calls = 0;
  const { server, port } = await listenOnFreePort((assigned) => {
    calls += 1;
    const created = fake();
    const error = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
    setImmediate(() => created.emit(calls === 1 ? 'error' : 'listening', calls === 1 ? error : undefined));
    created.assignedPort = assigned;
    return created;
  });
  assert.equal(calls, 2, '한 번 더 시도한다');
  assert.ok(Number.isInteger(port) && port > 0);
  assert.equal(server.assignedPort, port);

  // 포트 경쟁이 아닌 오류는 감추지 않는다.
  await assert.rejects(() => listenOnFreePort(() => {
    const created = fake();
    setImmediate(() => created.emit('error', Object.assign(new Error('boom'), { code: 'EACCES' })));
    return created;
  }), /boom/);
});
