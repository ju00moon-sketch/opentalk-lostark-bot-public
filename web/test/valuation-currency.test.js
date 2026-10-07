import test from 'node:test';
import assert from 'node:assert/strict';
import { createValuationCurrencyService } from '../src/valuation-currency.js';

const at = Date.parse('2026-09-16T03:00:00Z');
const row = { dt: '2026-09-16T00:00:00', close: 19750 };
const response = values => Response.json(values);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('fixed public endpoint, no credentials, precise unit conversion and in-flight sharing', async () => {
  let calls = 0, release;
  const wait = new Promise(resolve => { release = resolve; });
  const service = createValuationCurrencyService({ now: () => at, fetchImpl: async (url, init) => {
    calls++; assert.equal(url, 'https://loatool.taeu.kr/api/crystal-history/ohlc/1d');
    assert.equal(init.redirect, 'error'); assert.equal(init.headers.Authorization, undefined);
    await wait; return response([row]);
  } });
  const a = service.get(), b = service.get(); release();
  const [first, second] = await Promise.all([a, b]);
  assert.deepEqual(first, second); assert.equal(calls, 1);
  assert.equal(first.status, 'ok'); assert.equal(first.price95, 19750);
  assert.equal(first.pheonUnitGold, 19750 / 95 * 8.5);
  assert.equal(first.observedAt, Date.parse('2026-09-15T15:00:00Z'));
  first.price95 = 1; assert.equal((await service.get()).price95, 19750);
  service.close(); assert.equal((await service.get()).status, 'unavailable');
});

test('hourly cache expires and never reuses a candle older than three days', async () => {
  let clock = at, calls = 0;
  const service = createValuationCurrencyService({ now: () => clock, fetchImpl: async () => { calls++; return response([row]); } });
  await service.get(); clock += 3599999; await service.get(); assert.equal(calls, 1);
  clock++; await service.get(); assert.equal(calls, 2);
  clock += 3 * 86400000; assert.equal((await service.get()).status, 'unavailable');
  service.close();
});

test('malformed, future, stale and unordered prices are unavailable rather than zero', async () => {
  for (const values of [[], {}, [{ ...row, close: '19750' }], [{ ...row, close: 0 }],
    [{ ...row, dt: '2026-02-30T00:00:00' }], [{ ...row, dt: '2026-09-17T00:00:00' }],
    [{ ...row, dt: '2026-09-12T00:00:00' }], [row, { ...row, dt: '2026-09-15T00:00:00' }], [row, row]]) {
    const service = createValuationCurrencyService({ now: () => at, fetchImpl: async () => response(values) });
    const data = await service.get(); assert.equal(data.status, 'unavailable'); assert.equal(data.pheonUnitGold, null); service.close();
  }
});

test('HTTP, redirects, MIME, declared and streamed response limits fail closed', async () => {
  for (const make of [() => new Response('no', { status: 429 }), () => new Response('{}'),
    () => new Response('[]', { headers: { 'content-type': 'application/json', 'content-length': '300000' } }),
    () => new Response(' '.repeat(262145), { headers: { 'content-type': 'application/json' } }),
    () => { const r = response([row]); Object.defineProperty(r, 'redirected', { value: true }); return r; }]) {
    const service = createValuationCurrencyService({ now: () => at, fetchImpl: async () => make() });
    assert.equal((await service.get()).status, 'unavailable'); service.close();
  }
});

test('timeout retains the physical slot and refuses late cache writes', async () => {
  let calls = 0, finish;
  const service = createValuationCurrencyService({ now: () => at, requestTimeoutMs: 15, fetchImpl: () => {
    calls++; return new Promise(resolve => { finish = resolve; });
  } });
  assert.equal((await service.get()).status, 'unavailable');
  assert.equal((await service.get()).status, 'unavailable'); assert.equal(calls, 1);
  finish(response([row])); await pause(5);
  const next = service.get(); await pause(1); assert.equal(calls, 2);
  service.close(); assert.equal((await next).status, 'unavailable'); finish(response([row]));
});

test('shutdown resolves pending consumers, aborts transport and ignores a late body', async () => {
  let finish, signal;
  const service = createValuationCurrencyService({ now: () => at, fetchImpl: (_url, init) => {
    signal = init.signal; return new Promise(resolve => { finish = resolve; });
  } });
  const pending = service.get(); await pause(1); service.close();
  assert.equal(signal.aborted, true); assert.equal((await pending).status, 'unavailable');
  finish(response([row])); await pause(1); assert.equal((await service.get()).status, 'unavailable');
});
