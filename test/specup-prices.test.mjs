import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { buildSnapshots, __test } from '../src/specup-prices.js';

const at = Date.parse('2026-09-15T01:00:00+09:00');
const now = () => at;
const gem = (level) => `gem.겁화.${level}`;
const book = (name) => `market.engraving.${name}`;
const needsFor = (targets, materialIds = []) => ({
  targets, materialIds,
  engravingGrades: Object.fromEntries(targets.filter((key) => key.startsWith('market.')).map((key) => [key, '유물'])),
});
function snapshot(targets) {
  return {
    enhancement: { snapshotId: new Date(at - 1000).toISOString(), prices: { leapstone: 11, fusion: 12 } },
    auction: { snapshotId: new Date(at - 1000).toISOString(), pricesByTarget: Object.fromEntries(targets.map((key) => [key, 999])) },
    stale: false,
  };
}
function response(query) {
  if (query.startsWith('auction:')) return { Items: [{ AuctionInfo: { BuyPrice: 100 } }, { AuctionInfo: { BuyPrice: 120 } }] };
  const [, , name, grade] = query.split(':');
  return { Items: [{ Name: `${grade} ${name} 각인서`, Grade: grade, CurrentMinPrice: 200, BundleCount: 1 }] };
}

beforeEach(() => __test.resetPriceCache());

test('independent prices overlap within the global two-request limit without changing values', async () => {
  const targets = [gem(7), gem(8), gem(9), gem(10), book('원한'), book('아드레날린')];
  let active = 0;
  let maximum = 0;
  const calls = [];
  const result = await buildSnapshots(needsFor(targets), snapshot(targets), { now, fetchers: {
    async run(query) {
      calls.push(query);
      maximum = Math.max(maximum, ++active);
      // Completion order differs from selection order.
      await delay(query.includes('7레벨') ? 35 : 10);
      active--;
      return response(query);
    },
  } });
  assert.equal(maximum, 2);
  assert.equal(result.apiCalls, 6);
  assert.deepEqual(calls, ['auction:7레벨 겁화의 보석', 'auction:8레벨 겁화의 보석',
    'auction:9레벨 겁화의 보석', 'auction:10레벨 겁화의 보석', 'market:40000:원한:유물', 'market:40000:아드레날린:유물']);
  for (const key of targets) {
    assert.equal(result.auction.pricesByTarget[key], key.startsWith('gem.') ? 100 : 200);
    assert.equal(result.sourceByKey[key], 'api');
    assert.equal(result.timeByKey[key], at);
    assert.equal(result.staleByKey[key], false);
  }
  assert.deepEqual(result.missing, []);
});

test('the same fourteen requests win the budget, ahead of engraving overflow and materials', async () => {
  const gems = Array.from({ length: 10 }, (_, index) => gem(index + 1));
  const books = ['원한', '아드레날린', '저주받은 인형', '기습의 대가', '예리한 둔기'].map(book);
  const targets = [...books, ...gems]; // Input order does not change category priority.
  const calls = [];
  const result = await buildSnapshots(needsFor(targets, ['leapstone']), snapshot(targets), { now, fetchers: {
    async run(query) { calls.push(query); return response(query); },
  } });
  assert.equal(calls.length, 14);
  assert.ok(calls.slice(0, 10).every((query) => query.startsWith('auction:')));
  assert.deepEqual(calls.slice(10), books.slice(0, 4).map((key) => `market:40000:${key.slice('market.engraving.'.length)}:유물`));
  assert.equal(result.sourceByKey[books[4]], 'lopec');
  assert.equal(result.sourceByKey.leapstone, 'lopec');
  assert.equal(result.enhancement.prices.leapstone, 11);
});

test('zero budget does not issue requests and keeps snapshot fallback', async () => {
  const targets = [gem(10), book('원한')];
  const result = await buildSnapshots(needsFor(targets), snapshot(targets), {
    now, budget: 0, fetchers: { run() { assert.fail('No request is allowed'); } },
  });
  assert.equal(result.apiCalls, 0);
  assert.deepEqual(result.auction, snapshot(targets).auction);
  assert.deepEqual(result.sourceByKey, Object.fromEntries(targets.map((key) => [key, 'lopec'])));
});

test('simultaneous callers share pending requests and cached results without extra API calls', async () => {
  const targets = [gem(9), gem(10), book('원한')];
  let calls = 0;
  let active = 0;
  let maximum = 0;
  const options = { now, fetchers: { async run(query) {
    calls++;
    maximum = Math.max(maximum, ++active);
    await delay(10);
    active--;
    return response(query);
  } } };
  const [first, shared] = await Promise.all([
    buildSnapshots(needsFor(targets), snapshot(targets), options),
    buildSnapshots(needsFor(targets), snapshot(targets), options),
  ]);
  const cached = await buildSnapshots(needsFor(targets), snapshot(targets), options);
  assert.equal(calls, 3);
  assert.equal(maximum, 2);
  assert.equal(first.apiCalls + shared.apiCalls, 3);
  assert.equal(cached.apiCalls, 0);
  assert.deepEqual(first.auction, shared.auction);
  assert.deepEqual(first.auction, cached.auction);
  assert.deepEqual(first.timeByKey, cached.timeByKey);
});

test('failed and invalid prices fall back without being cached, then recover', async () => {
  const targets = [gem(9), gem(10)];
  const initial = await buildSnapshots(needsFor(targets), snapshot(targets), { now, fetchers: {
    async run(query) {
      if (query.includes('9레벨')) throw new Error('upstream unavailable');
      return { Items: [{ AuctionInfo: { BuyPrice: 0 } }] };
    },
  } });
  assert.deepEqual(initial.auction, snapshot(targets).auction);
  assert.deepEqual(initial.sourceByKey, Object.fromEntries(targets.map((key) => [key, 'lopec'])));
  const recovered = await buildSnapshots(needsFor(targets), snapshot(targets), { now, fetchers: { async run(query) { return response(query); } } });
  assert.equal(recovered.apiCalls, 2);
  assert.ok(targets.every((key) => recovered.sourceByKey[key] === 'api'));
});

test('material pages wait for target queries and stop as soon as all required items are found', async () => {
  const targets = [gem(10), book('원한')];
  const calls = [];
  let targetActive = 0;
  const result = await buildSnapshots(needsFor(targets, ['leapstone', 'fusion']), snapshot(targets), { now, fetchers: {
    async run(query) {
      calls.push(query);
      if (!query.startsWith('market:50010:')) {
        targetActive++;
        await delay(10);
        targetActive--;
        return response(query);
      }
      assert.equal(targetActive, 0);
      const page = Number(query.split(':').at(-1));
      assert.ok(page <= 2);
      return { TotalCount: 30, PageSize: 10, Items: [{
        Name: page === 1 ? '운명의 돌파석' : '아비도스 융화 재료',
        CurrentMinPrice: page * 30, BundleCount: 10,
      }] };
    },
  } });
  assert.deepEqual(calls, ['auction:10레벨 겁화의 보석', 'market:40000:원한:유물', 'market:50010::1', 'market:50010::2']);
  assert.equal(result.enhancement.prices.leapstone, 3);
  assert.equal(result.enhancement.prices.fusion, 6);
  assert.equal(result.apiCalls, 4);
});
