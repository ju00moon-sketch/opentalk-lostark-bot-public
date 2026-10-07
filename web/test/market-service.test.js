import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarketService, normalizeMarketSearch, calculateMarketBid } from '../src/market-service.js';
import { evenShareBid, preemptBid, resaleCap } from '../../src/bid-calculation.js';
import { GuildError } from '../src/guild-store.js';

const config = { automaticApproval: { lostArkApiKey: 'synthetic-test-key' } };
const image = 'https://cdn-lostark.game.onstove.com/efui_iconatlas/use/use_1_1.png';
const item = (Id = 100) => ({ Id, Name: '운명의 돌파석', Grade: '유물', Icon: image,
  BundleCount: 10, TradeRemainCount: null, CurrentMinPrice: 550, YDayAvgPrice: 500, RecentPrice: 520 });
const errorIs = (status, code) => error => error.status === status && (!code || error.code === code);
function fixture(t, options = {}) {
  const calls = [], optionCalls = [], control = { response: null, hook: null, headers: {} };
  let timestamp = 1800000000000;
  const fetchImpl = async (url, init) => {
    assert.equal(new URL(url).origin, 'https://developer-lostark.game.onstove.com');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, 'bearer synthetic-test-key');
    const path = new URL(url).pathname;
    if (path.endsWith('/options')) {
      optionCalls.push(path);
      return Response.json({ Categories: [{ Code: 50000, CodeName: '강화 재료', Subs: [{ Code: 50010, CodeName: '재련 재료' }] }] });
    }
    calls.push({ path, init, body: init.body ? JSON.parse(init.body) : null });
    if (control.hook) await control.hook(init.signal);
    if (control.response) return control.response();
    if (/\/markets\/items\/\d+$/.test(path)) return Response.json([{ Name: '운명의 돌파석', BundleCount: 10, TradeRemainCount: null,
      Stats: [{ Date: '2026-09-14', AvgPrice: 500, TradeCount: 20 }, { Date: '2026-09-13', AvgPrice: 490, TradeCount: 12 }] }], { headers: control.headers });
    const body = JSON.parse(init.body);
    const Items = path.startsWith('/auctions') ? [{ Name: body.ItemName, Grade: '고대', Icon: image,
      AuctionInfo: { BuyPrice: 900000, BidStartPrice: 800000 }, Options: [{ ClassName: '바드', OptionName: '천상의 연주', Value: 24, IsValuePercentage: true }] }] : [item()];
    return Response.json({ PageNo: body.PageNo, PageSize: 10, TotalCount: 11, Items }, { headers: control.headers });
  };
  const service = createMarketService({ config, fetchImpl, now: () => timestamp, ...options });
  t.after(() => service.close());
  return { service, control, calls, optionCalls, advance(ms) { timestamp += ms; } };
}

test('market inputs normalize NFC and whitespace; category is required for empty search', () => {
  assert.deepEqual(normalizeMarketSearch({ query: '  운명의   돌파석 '.normalize('NFD') }), {
    kind: 'market', query: '운명의 돌파석', category: 50010, page: 1, sort: 'CURRENT_MIN_PRICE', order: 'ASC',
  });
  assert.equal(normalizeMarketSearch({ query: '', category: 50010 }).category, 50010);
  assert.throws(() => normalizeMarketSearch({ query: '운명의', category: 0 }), errorIs(400));
  for (const input of [{ query: '<img>' }, { query: '\u0000' }, { query: '가'.repeat(61) }, { query: '\ud800' }, { page: 101 },
    { page: 1.1 }, { category: -1 }, { sort: 'TRADE_COUNT' }, { order: 'sideways' }, { kind: 'arbitrary' }]) {
    assert.throws(() => normalizeMarketSearch(input), errorIs(400));
  }
});
test('gem abbreviations reuse the bot parser and constrain request shape', () => {
  for (const [query, full] of [['10겁', '10레벨 겁화의 보석'], ['작열 9', '9레벨 작열의 보석'], ['1레벨 겁화의 보석', '1레벨 겁화의 보석']]) {
    assert.equal(normalizeMarketSearch({ kind: 'gems', query }).query, full);
  }
  for (const query of ['', '11겁', '겁화', '10멸', '10겁<script>']) assert.throws(() => normalizeMarketSearch({ kind: 'gems', query }), errorIs(400));
  assert.throws(() => normalizeMarketSearch({ kind: 'gems', query: '10겁', sort: 'CURRENT_MIN_PRICE' }), errorIs(400));
});
test('structured market rows use bundled prices and accurate change calculation', async t => {
  const f = fixture(t), result = await f.service.search({ query: '운명의' });
  assert.equal(result.items[0].currentMinPrice, 550);
  assert.equal(result.items[0].bundleCount, 10);
  assert.equal(result.items[0].changePercent, 10);
  assert.equal(result.items[0].recentPrice, 520);
  assert.equal(result.items[0].icon, image);
  assert.equal(result.pageCount, 2);
  assert.deepEqual(f.calls[0].body, { Sort: 'CURRENT_MIN_PRICE', CategoryCode: 50010, ItemName: '운명의', PageNo: 1, SortCondition: 'ASC', ItemGrade: null });
  assert.equal(JSON.stringify(result).includes('synthetic-test-key'), false);
});
test('in-flight requests share work and five-minute cache expires', async t => {
  const f = fixture(t); let done;
  f.control.hook = () => new Promise(resolve => { done = resolve; });
  const a = f.service.search({ query: '운명의' }), b = f.service.search({ query: ' 운명의 ' });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.length, 1); done();
  assert.deepEqual(await a, await b); f.control.hook = null;
  await f.service.search({ query: '운명의' }); assert.equal(f.calls.length, 1);
  f.advance(300001); await f.service.search({ query: '운명의' }); assert.equal(f.calls.length, 2);
});
test('options normalize category hierarchy and reject unknown categories without search call', async t => {
  const f = fixture(t);
  const result = await f.service.options(); assert.deepEqual(result.categories[1], { code: 50010, name: '재련 재료', parent: 50000 });
  await f.service.search({ category: 50000, query: '' }); assert.equal(f.calls.length, 1);
  await assert.rejects(f.service.search({ category: 10000 }), errorIs(400)); assert.equal(f.calls.length, 1); assert.equal(f.optionCalls.length, 1);
});
test('bounded cache evicts oldest entries', async t => {
  const f = fixture(t, { maxEntries: 2 });
  for (const query of ['돌', '약', '책', '돌']) await f.service.search({ query });
  assert.equal(f.calls.length, 4);
});
test('unavailable prices stay unknown and markup/icon URLs never escape normalization', async t => {
  const f = fixture(t);
  f.control.response = () => Response.json({ PageNo: 1, PageSize: 10, TotalCount: 1, Items: [{ ...item(), Name: '<b>운명의 돌파석</b>', Icon: 'https://example.com/a.png', CurrentMinPrice: 0, YDayAvgPrice: 0, RecentPrice: null }] });
  const row = (await f.service.search({})).items[0];
  assert.equal(row.name, '운명의 돌파석'); assert.equal(row.icon, null); assert.equal(row.currentMinPrice, null); assert.equal(row.changePercent, null); assert.equal(row.recentPrice, null);
});
test('gem auction keeps non-buyable listings distinguishable and maps actual skill options', async t => {
  const f = fixture(t), result = await f.service.search({ kind: 'gems', query: '10겁', page: 2 });
  assert.equal(f.calls[0].path, '/auctions/items'); assert.equal(f.calls[0].body.ItemTier, 4); assert.equal(f.calls[0].body.CategoryCode, 210000);
  assert.equal(result.items[0].options[0].className, '바드'); assert.equal(result.items[0].currentMinPrice, 900000);
  f.control.response = () => Response.json({ PageNo: 1, PageSize: 10, TotalCount: 1, Items: [{ Name: '9레벨 작열의 보석', Grade: '전설', AuctionInfo: { BuyPrice: null, BidStartPrice: 900 } }] });
  assert.equal((await f.service.search({ kind: 'gems', query: '9작' })).items[0].currentMinPrice, null);
});
test('history keeps official dates, average prices and volume per trade variant', async t => {
  const f = fixture(t), result = await f.service.history(100);
  assert.equal(f.calls[0].path, '/markets/items/100');
  assert.equal(result.variants[0].history[0].date, '2026-09-13');
  assert.equal(result.variants[0].history[1].tradeCount, 20);
  assert.equal(result.variants[0].bundleCount, 10);
  await f.service.history('100'); assert.equal(f.calls.length, 1);
  await assert.rejects(f.service.history('../1'), errorIs(400));
});
test('history invalid dates, duplicate dates and invalid numeric records are rejected', async t => {
  for (const history of [[{ Date: 'bad', AvgPrice: 1, TradeCount: 1 }], [{ Date: '2026-02-30', AvgPrice: 1, TradeCount: 1 }], [{ Date: '2026-01-01', AvgPrice: -1, TradeCount: 1 }],
    [{ Date: '2026-01-01', AvgPrice: 1, TradeCount: 1 }, { Date: '2026-01-01', AvgPrice: 2, TradeCount: 2 }]]) {
    const f = fixture(t); f.control.response = () => Response.json([{ Name: '돌', BundleCount: 1, Stats: history }]);
    await assert.rejects(f.service.history(100), errorIs(502));
  }
});
test('404, 429 and other upstream failures are mapped without exposing upstream bodies', async t => {
  for (const [status, expected] of [[404, 404], [429, 429], [401, 502], [500, 502], [503, 502]]) {
    const f = fixture(t); f.control.response = () => Response.json({ key: 'secret' }, { status });
    await assert.rejects(f.service.search({}), error => error.status === expected && !error.message.includes('secret'));
  }
  const f = fixture(t, { config: { automaticApproval: { lostArkApiKey: '' } } });
  await assert.rejects(f.service.options(), errorIs(503)); assert.equal(f.calls.length, 0);
});
test('rate exhaustion backs off while cached results remain accessible', async t => {
  const f = fixture(t); await f.service.search({ query: '돌' });
  f.control.headers = { 'X-RateLimit-Remaining': '9' };
  await f.service.search({ query: '약' }); await f.service.search({ query: '돌' });
  await assert.rejects(f.service.search({ query: '책' }), errorIs(429)); assert.equal(f.calls.length, 2);
  f.advance(60001); f.control.headers = {}; await f.service.search({ query: '책' }); assert.equal(f.calls.length, 3);
});
test('shared official transport rate errors map to the market error contract', async t => {
  const f = fixture(t);
  f.control.hook = async () => { throw new GuildError(429, 'character_rate_limited'); };
  await assert.rejects(f.service.search({}), errorIs(429, 'market_rate_limited'));
});
test('local transport budget bounds unique work and per-IP attempts expire', async t => {
  const f = fixture(t, { upstreamPerMinute: 3 });
  await f.service.search({ query: '가' }); await f.service.search({ query: '나' });
  await assert.rejects(f.service.search({ query: '다' }), errorIs(429));
  for (let i = 0; i < 40; i++) assert.equal(f.service.allow('client'), true);
  assert.equal(f.service.allow('client'), false); assert.equal(f.service.allow('another'), true);
  f.advance(60001); assert.equal(f.service.allow('client'), true); await f.service.search({ query: '다' });
});
test('timeout aborts active fetch and releases its slot', async t => {
  const f = fixture(t, { requestTimeoutMs: 20 });
  f.control.hook = signal => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  await assert.rejects(f.service.search({ query: '돌' }), errorIs(502));
  assert.equal(f.calls[0].init.signal.aborted, true);
  f.control.hook = null; await f.service.search({ query: '약' });
});
test('concurrency stays at two and close aborts queued and active work', async t => {
  const f = fixture(t); let active = 0, maximum = 0;
  f.control.hook = signal => new Promise((resolve, reject) => { active++; maximum = Math.max(maximum, active);
    signal.addEventListener('abort', () => { active--; reject(new Error('aborted')); }, { once: true }); });
  const jobs = ['가', '나', '다', '라'].map(query => f.service.search({ query }));
  const outcomes = Promise.allSettled(jobs);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.length, 2); assert.equal(maximum, 2);
  f.service.close(); assert.equal((await outcomes).every(row => row.status === 'rejected'), true);
  await assert.rejects(f.service.options(), errorIs(502));
});
test('HTML, oversized JSON, malformed response pagination and malformed items fail closed', async t => {
  for (const response of [() => new Response('<html>error</html>'), () => new Response(' '.repeat(1048577), { headers: { 'Content-Type': 'application/json' } }),
    () => Response.json({ PageNo: 1, PageSize: 0, TotalCount: 1, Items: [] }),
    () => Response.json({ PageNo: 1, PageSize: 10, TotalCount: 1, Items: [{ ...item(), Id: Number.MAX_SAFE_INTEGER + 1 }] }),
    () => Response.json({ PageNo: 1, PageSize: 10, TotalCount: 1, Items: [{ ...item(), BundleCount: 0 }] })]) {
    const f = fixture(t); f.control.response = response; await assert.rejects(f.service.search({}), errorIs(502));
  }
});
test('bid calculator shares bot formula without integer-boundary drift', () => {
  assert.equal(calculateMarketBid(8800, 4).preempt, 5700);
  assert.equal(calculateMarketBid(8800, 4).evenShare, 6270);
  assert.equal(calculateMarketBid(8800, 4).resaleCap, 8360);
  for (const price of [1, 100, 8800, 1000000000]) for (const party of [4, 8, 16]) {
    const value = calculateMarketBid(price, party);
    assert.equal(value.preempt, Math.floor(preemptBid(price, party)));
    assert.equal(value.evenShare, Math.floor(evenShareBid(price, party)));
    assert.equal(value.resaleCap, Math.floor(resaleCap(price)));
  }
  for (const [price, party] of [[0, 4], [-1, 4], [1.1, 4], [1000000001, 4], [NaN, 4], [10, 5]]) assert.throws(() => calculateMarketBid(price, party), errorIs(400));
});
