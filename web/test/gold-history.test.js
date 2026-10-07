import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createGoldHistoryService, goldServers, normalizeGoldHistory } from '../src/gold-history.js';
import { createWebServer } from '../src/server.js';
import { approvedRequester } from './helpers/access.js';

const today = Date.parse('2026-09-16T00:00:00+09:00'), now = today + 3600000;
const candle = (time, close = 800) => ({ time: time / 1000, open: close, high: close + 10, low: close - 10, close, volume: 10000 });
const rows = () => [candle(today - 86400000, 1000), candle(today, 800)];

test('daily close retains KRW per 10,000 gold and compares consecutive Korean dates', () => {
  const result = normalizeGoldHistory(rows().reverse(), goldServers[0], now);
  assert.deepEqual(result.history.map(row => row.date), ['2026-09-15', '2026-09-16']);
  assert.deepEqual(result.unit, { gold: 10000, currency: 'KRW' });
  assert.equal(result.currentPrice, 800); assert(Math.abs(result.changePercent + 20) < 1e-10);
  assert.equal(result.isToday, true); assert.equal(result.servers.length, 8);
  const gap = normalizeGoldHistory([candle(today - 3 * 86400000), candle(today)], goldServers[0], now);
  assert.equal(gap.changePercent, null);
  assert.equal(normalizeGoldHistory([candle(today - 86400000)], goldServers[0], now).isToday, false);
});

test('malformed, duplicated, future or wrongly timed candles cannot become prices', () => {
  for (const mutate of [row => row.close = '800', row => row.close = -1, row => row.high = 700,
    row => row.low = 900, row => row.volume = -1, row => row.time++, row => row.time += 86400]) {
    const row = candle(today); mutate(row);
    assert.throws(() => normalizeGoldHistory([row], goldServers[0], now), { code: 'gold_history_unavailable' });
  }
  for (const value of [[], null, [candle(today), candle(today)], Array(401).fill(candle(today))])
    assert.throws(() => normalizeGoldHistory(value, goldServers[0], now));
});

test('same-server work shares requests and cache while all eight servers keep independent prices', async t => {
  let timestamp = now, calls = 0;
  const service = createGoldHistoryService({ now: () => timestamp, cacheMs: 100,
    fetchImpl: async (url, init) => {
      calls++; const u = new URL(url); assert.equal(u.origin, 'https://gamebit.co.kr');
      assert.equal(u.pathname, '/v3_get_chart_data.php'); assert.equal(u.searchParams.get('type'), 'day');
      assert.equal(init.headers.Authorization, undefined); assert.equal(init.headers.Cookie, undefined); assert.equal(init.redirect, 'error');
      return Response.json(rows());
    } }); t.after(() => service.close());
  const values = await Promise.all([service.get(), service.get('lupeon'), service.get('lupeon')]);
  assert.equal(calls, 1); assert.deepEqual(values[0], values[1]);
  for (const server of goldServers) assert.equal((await service.get(server.id)).server.id, server.id);
  assert.equal(calls, 8); timestamp += 101; await service.get(); assert.equal(calls, 9);
  for (const id of ['../lupeon', 'https://other.invalid', '루페온', '', '__proto__']) await assert.rejects(service.get(id), { status: 400 });
  assert.equal(calls, 9);
});

test('upstream failures back off and stale cache is not presented as fresh data', async t => {
  let timestamp = now, calls = 0;
  const service = createGoldHistoryService({ now: () => timestamp, cacheMs: 100,
    fetchImpl: async () => ++calls === 1 ? Response.json(rows()) : new Response('', { status: 503 }) });
  t.after(() => service.close()); await service.get(); timestamp += 101;
  await assert.rejects(service.get(), { status: 502 }); await assert.rejects(service.get(), { status: 502 }); assert.equal(calls, 2);
  timestamp += 30001; await assert.rejects(service.get(), { status: 502 }); assert.equal(calls, 3);
});

test('response bytes, timeouts and shutdown are bounded', async () => {
  for (const fetchImpl of [async () => new Response('x'.repeat(262145)),
    async (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]) {
    const service = createGoldHistoryService({ now: () => now, timeoutMs: 20, fetchImpl });
    await assert.rejects(service.get(), { status: 502 }); service.close(); await assert.rejects(service.get(), { status: 503 });
  }
  const service = createGoldHistoryService({ now: () => now });
  for (let i = 0; i < 30; i++) assert.equal(service.allow('ip'), true);
  assert.equal(service.allow('ip'), false); service.close();
});

test('HTTP gold route requires approval, rejects extra query and never forwards account or game keys', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'gold-history-web-')); let calls = 0;
  const app = createWebServer({ now: () => now, config: { origin: 'https://opentalk.example.invalid', host: '127.0.0.1', port: 0,
    dbPath: join(directory, 'state.sqlite'), providers: {}, automaticApproval: { lostArkApiKey: 'synthetic-secret' } },
    fetchImpl: async (url, init) => { calls++; assert.equal(new URL(url).origin, 'https://gamebit.co.kr');
      assert.equal(init.headers.Authorization, undefined); assert.equal(init.headers.Cookie, undefined); return Response.json(rows()); } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const request = approvedRequester(join(directory, 'state.sqlite'), now);
  const base = 'http://127.0.0.1:' + app.server.address().port, path = '/api/market/gold-history';
  assert.equal((await fetch(base + path)).status, 401); assert.equal(calls, 0);
  for (const suffix of ['?server=invalid', '?server=lupeon&server=aman', '?server=lupeon&url=https://other.invalid'])
    assert.equal((await request(base + path + suffix)).status, 400);
  assert.equal((await request(base + path, { headers: { Origin: 'https://other.invalid' } })).status, 403);
  assert.equal((await request(base + path, { method: 'POST' })).status, 405); assert.equal(calls, 0);
  const response = await request(base + path), body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.server.id, 'lupeon'); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(calls, 1); assert.equal(JSON.stringify(body).includes('synthetic-secret'), false);
});
