// 공지·이벤트 목록 캐시(memoTtl) — 성공만 기억, 실패는 재시도, 동시 호출 합치기, 만료 뒤 재조회.
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoTtl } from '../src/memo-ttl.js';

function clock(start = 1_000_000) {
  let at = start;
  return { now: () => at, tick: (ms) => { at += ms; } };
}

test('성공한 결과는 TTL 동안 재조회 없이 같은 값을 돌려주고 만료 뒤에는 다시 조회한다', async () => {
  const c = clock();
  let calls = 0;
  const load = memoTtl(async () => ({ n: ++calls }), 60_000, { now: c.now });
  const first = await load();
  assert.deepEqual(first, { n: 1 });
  c.tick(59_999);
  assert.equal(await load(), first, '만료 전에는 같은 객체');
  assert.equal(calls, 1);
  c.tick(2);
  assert.deepEqual(await load(), { n: 2 });
  assert.equal(calls, 2);
});

test('진행 중인 조회는 동시 호출이 함께 기다리고 조회는 한 번만 한다', async () => {
  const c = clock();
  let calls = 0;
  let release;
  const load = memoTtl(() => new Promise((resolve) => { calls++; release = () => resolve(['ok']); }), 60_000, { now: c.now });
  const a = load();
  const b = load();
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await a, ['ok']);
  assert.equal(await b, await a);
});

test('실패는 기억하지 않아 다음 호출이 다시 시도하고, 그 뒤 성공은 기억한다', async () => {
  const c = clock();
  let calls = 0;
  const load = memoTtl(async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('로스트아크 API 오류 (HTTP 503)'), { status: 503 });
    return ['notice'];
  }, 60_000, { now: c.now });
  await assert.rejects(load(), /503/);
  assert.deepEqual(await load(), ['notice']);
  assert.deepEqual(await load(), ['notice']);
  assert.equal(calls, 2);
});

test('clear()는 기억을 비워 다음 호출이 다시 조회하게 한다', async () => {
  const c = clock();
  let calls = 0;
  const load = memoTtl(async () => ++calls, 60_000, { now: c.now });
  assert.equal(await load(), 1);
  load.clear();
  assert.equal(await load(), 2);
});
