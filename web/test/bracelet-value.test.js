import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createBraceletValueService } from '../src/bracelet-value.js';
import { GuildError } from '../src/guild-store.js';

const clock = Date.parse('2026-09-16T00:00:00Z');
const config = { automaticApproval: { lostArkApiKey: 'synthetic-bracelet-key' } };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
function detail(name = '시험캐릭터', crit = 90, grantedValue = 100) {
  const target = [{ fixed: true, text: `치명 +${crit}`, id: 'combat.crit', value: crit },
    { fixed: true, text: '특화 +90', id: 'combat.specialization', value: 90 },
    { fixed: false, text: `신속 +${grantedValue}`, id: 'combat.swiftness', value: grantedValue },
    { fixed: false, text: '힘 +10000', id: 'base.mainStat', value: 10000 },
    { fixed: false, text: '체력 +10000', id: 'base.vitality', value: 10000 }];
  const rarity = 'ancient', targetKey = createHash('sha256').update(JSON.stringify({ rarity, target })).digest('hex');
  return { efficiency: { source: 'official-api', characterName: name, braceletExpectation: { status: 'ok', rarity, target, targetKey,
    scenarios: [{ reconversionTickets: 3, totalRolls:7, expectedStartingBracelets: 4, successProbability: .25, expectedReconversionTicketsPerBracelet:2,expectedReconversionTicketsUntilSuccess:8 },
      { reconversionTickets:0,totalRolls:4,expectedStartingBracelets:20,successProbability:.05 }, { reconversionTickets: 5, expectedStartingBracelets: 1, successProbability: 1 }] } } };
}
function auctionItem(price, index = 0, crit = 90) {
  return { Name: '시험용 고대 팔찌', Grade: '고대', Tier: 4,
    AuctionInfo: { BuyPrice: price, StartPrice: price, BidPrice: 0, BidStartPrice: price, BidCount: 0, IsCompetitive: false,
      TradeAllowCount: 0, EndDate: `2026-09-17T12:${String(Math.floor(index / 60) % 60).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000` },
    Options: [{ Type: 'BRACELET_RANDOM_SLOT', OptionName: '부여 효과 수량', Value: 3, IsPenalty: false, IsValuePercentage: false },
      { Type: 'STAT', OptionName: '치명', Value: crit, IsPenalty: false, IsValuePercentage: false },
      { Type: 'STAT', OptionName: '특화', Value: 90, IsPenalty: false, IsValuePercentage: false }] };
}
function page(PageNo = 1, TotalCount = 10, price = () => 100, crit = 90) {
  const start = (PageNo - 1) * 10;
  return { PageNo, PageSize: 10, TotalCount, Items: Array.from({ length: Math.max(0, Math.min(10, TotalCount - start)) }, (_, i) => auctionItem(price(start + i), start + i, crit)) };
}
function service(options = {}) { return createBraceletValueService({ config, now: () => clock, readDetails: async name => detail(name), fetchImpl: async (_url, init) => response(page(JSON.parse(init.body).PageNo)), ...options }); }

test('five price-rank pages represent the full listing range and remove a log-price outlier', async t => {
  const requested = [], app = service({ fetchImpl: async (url, init) => {
    assert.equal(url, 'https://developer-lostark.game.onstove.com/auctions/items'); assert.equal(init.redirect, 'error');
    const body = JSON.parse(init.body); requested.push(body.PageNo); assert.equal(body.Sort, 'BUY_PRICE'); assert.equal(body.SortCondition, 'ASC');
    assert.ok(body.EtcOptions.filter(option => option.FirstOption === 2).every(option => option.MinValue === 85 && option.MaxValue === 95));
    return response(page(body.PageNo, 335, i => i >= 329 ? 1000000 : 100));
  } }); t.after(() => app.close());
  const r = await app.get('시험캐릭터'); assert.deepEqual(requested, [1, 9, 17, 25, 33]);
  assert.equal(r.price.meanGold, 100); assert.equal(r.price.sampleCount, 50); assert.equal(r.price.usedCount, 49); assert.equal(r.price.excludedCount, 1);
  assert.equal(r.price.omittedTailCount, 5); assert.equal(r.price.omittedTailPage, 34);
  assert.equal(r.expectedStartingBracelets, 4); assert.equal(r.costExpectedGold, 400); assert.equal(r.reconversionTickets, 3);
  assert.equal(r.totalRolls,7);assert.equal(r.expectedReconversionTicketsPerBracelet,2);assert.equal(r.expectedReconversionTicketsUntilSuccess,8);
  assert.equal(r.reconversionTicketUnitGold,null);assert.equal(r.reconversionTicketCostGold,null);
  assert.equal(r.price.totalCount, 335); assert.equal(r.price.checkedAt, clock); assert.equal(JSON.stringify(r).includes('synthetic-bracelet-key'), false);
});
test('1000 to1001 listings retains balanced50 samples and small markets include the partial tail', async t => {
  const results = [];
  for (const count of [1000, 1001, 45]) {
    const app = service({ fetchImpl: async (_url, init) => response(page(JSON.parse(init.body).PageNo, count, i => 500 + i)) }); t.after(() => app.close());
    results.push(await app.get('시험캐릭터'));
  }
  const [a, b, small] = results;
  assert.deepEqual(a.price.pages, [1, 26, 51, 75, 100]); assert.deepEqual(b.price.pages, a.price.pages);
  assert.equal(a.price.sampleCount, 50); assert.equal(b.price.sampleCount, 50); assert.equal(b.price.meanGold, a.price.meanGold);
  assert.equal(a.price.omittedTailCount, 0); assert.equal(b.price.omittedTailCount, 1); assert.equal(b.price.omittedTailPage, 101);
  assert.deepEqual(small.price.pages, [1, 2, 3, 4, 5]); assert.equal(small.price.sampleCount, 45);
  assert.equal(small.price.meanGold, 522); assert.equal(small.price.samplingMethod, 'all-listings'); assert.equal(small.price.omittedTailCount, 0);
});
test('normalized condition cache is shared but each reply carries current target and expectation', async t => {
  let calls = 0, current = detail(), timestamp = clock;
  const app = service({ now: () => timestamp, readDetails: async name => ({ efficiency: { ...current.efficiency, characterName: name } }),
    fetchImpl: async (_url, init) => { calls++; await delay(5); const crit = JSON.parse(init.body).EtcOptions.find(option => option.FirstOption === 2 && option.SecondOption === 15).MinValue; return response(page(1, 10, () => 100, crit)); } }); t.after(() => app.close());
  const [a, b] = await Promise.all([app.get('시험캐릭터'), app.get('다른캐릭터')]); assert.equal(calls, 1); assert.equal(b.characterName, '다른캐릭터');
  current = detail('시험캐릭터', 90, 105); current.efficiency.braceletExpectation.scenarios[0] = { reconversionTickets: 3,totalRolls:7, expectedStartingBracelets: 8, successProbability: .125,expectedReconversionTicketsPerBracelet:2,expectedReconversionTicketsUntilSuccess:16 };
  const c = await app.get('시험캐릭터'); assert.equal(calls, 1); assert.notEqual(c.targetKey, a.targetKey); assert.equal(c.costExpectedGold, 800);
  c.price.meanGold = 1; assert.equal((await app.get('시험캐릭터')).price.meanGold, 100);
  c.price.conditions.fixed[0].value = 120; assert.equal((await app.get('시험캐릭터')).price.conditions.fixed[0].value, 90);
  current = detail('시험캐릭터', 91); await app.get('시험캐릭터'); assert.equal(calls, 2);
  timestamp += 15 * 60000 + 1; await app.get('시험캐릭터'); assert.equal(calls, 3);
});
test('bounded comparison conditions are exposed and higher-stat offers never enter the reference price', async t => {
  let calls = 0, better = false;
  const app = service({ readDetails: async name => detail(name, 83), cacheMs: 0,
    fetchImpl: async (_url, init) => {
      calls++; const body = JSON.parse(init.body);
      assert.deepEqual(body.EtcOptions.slice(0, 2), [
        { FirstOption: 2, SecondOption: 15, MinValue: 78, MaxValue: 88 },
        { FirstOption: 2, SecondOption: 16, MinValue: 85, MaxValue: 95 }]);
      const result = page(1, 1, () => better ? 82000 : 19800, better ? 120 : 83);
      if (better) result.Items[0].Options[2].Value = 120;
      return response(result);
    } }); t.after(() => app.close());
  const r = await app.get('시험캐릭터'); assert.equal(r.price.meanGold, 19800); assert.equal(r.costExpectedGold, 79200);
  assert.equal(r.price.basisVersion, 'bounded-combat-v2'); assert.equal(r.price.relaxation, 'none'); assert.equal(r.price.comparison, 'nearby');
  assert.deepEqual(r.price.conditions, { tier: 4, grade: '고대', fixedCount: 2, grantedCount: 3,
    fixed: [{ name: '치명', operator: 'range', value: 83, min: 78, max: 88, tolerance: 5, used: true }, { name: '특화', operator: 'range', value: 90, min: 85, max: 95, tolerance: 5, used: true }] });
  better = true; await assert.rejects(app.get('시험캐릭터'), { status: 502 }); assert.equal(calls, 2);
});
test('empty nearby listings retain conditions and do not widen or launch a fallback search', async t => {
  let calls = 0; const app = service({ fetchImpl: async () => { calls++; return response(page(1, 0)); } }); t.after(() => app.close());
  const r = await app.get('시험캐릭터'); assert.equal(calls, 1); assert.equal(r.status, 'no_listings'); assert.equal(r.price.comparison, 'nearby');
  assert.equal(r.price.conditions.fixed[0].min, 85); assert.equal(r.price.conditions.fixed[0].max, 95); assert.equal(r.price.meanGold, null);
});
test('combat windows shrink at each rarity cap and the result preserves the original probability target', async t => {
  for (const [rarity, value, minimum, maximum, tolerance] of [
    ['ancient', 90, 85, 95, 5], ['ancient', 118, 116, 120, 2], ['ancient', 119, 118, 120, 1], ['ancient', 120, 120, 120, 0],
    ['ancient', 61, 61, 66, 5], ['relic', 98, 96, 100, 2], ['relic', 99, 98, 100, 1], ['relic', 100, 100, 100, 0], ['relic', 41, 41, 46, 5],
  ]) {
    const original = detail('시험캐릭터', value), expectation = original.efficiency.braceletExpectation;
    expectation.rarity = rarity;
    expectation.target[1] = { fixed: true, text: `특화 +${value}`, id: 'combat.specialization', value };
    if (rarity === 'relic') expectation.target.pop();
    expectation.targetKey = createHash('sha256').update(JSON.stringify({ rarity, target: expectation.target })).digest('hex');
    const before = JSON.stringify(original); let calls = 0;
    const app = service({ readDetails: async () => original, fetchImpl: async (_url, init) => {
      calls++; const body = JSON.parse(init.body);
      assert.ok(body.EtcOptions.filter(option => option.FirstOption === 2).every(option => option.MinValue === minimum && option.MaxValue === maximum));
      const result = page(1, 2, () => 100, minimum);
      for (let i = 0; i < result.Items.length; i++) {
        const item = result.Items[i]; item.Grade = rarity === 'ancient' ? '고대' : '유물';
        item.Options[0].Value = rarity === 'ancient' ? 3 : 2;
        item.Options[1].Value = i ? maximum : minimum; item.Options[2].Value = value;
      }
      return response(result);
    } }); t.after(() => app.close());
    const result = await app.get('시험캐릭터');
    assert.equal(calls, 1); assert.equal(result.price.basisVersion, 'bounded-combat-v2'); assert.equal(result.price.relaxation, 'none');
    assert.equal(result.price.comparison, tolerance ? 'nearby' : 'exact');
    assert.deepEqual(result.price.conditions.fixed.map(rule => [rule.min, rule.max, rule.value, rule.tolerance, rule.operator]),
      Array.from({ length: 2 }, () => [minimum, maximum, value, tolerance, tolerance ? 'range' : '=']));
    assert.equal(result.price.meanGold, 100); assert.equal(result.successProbability, .25); assert.equal(result.expectedStartingBracelets, 4);
    assert.equal(result.costExpectedGold, 400); assert.equal(result.targetKey, expectation.targetKey); assert.equal(JSON.stringify(original), before);
  }
});
test('mixed capped and nearby combat values remain separate and reject values above the official maximum', async t => {
  const original = detail('시험캐릭터', 120), expectation = original.efficiency.braceletExpectation;
  expectation.target[1] = { fixed: true, text: '특화 +118', id: 'combat.specialization', value: 118 };
  expectation.targetKey = createHash('sha256').update(JSON.stringify({ rarity: expectation.rarity, target: expectation.target })).digest('hex');
  let specialization = 116;
  const app = service({ cacheMs: 0, readDetails: async () => original, fetchImpl: async () => {
    const result = page(1, 1, () => 100, 120); result.Items[0].Options[2].Value = specialization; return response(result);
  } }); t.after(() => app.close());
  const result = await app.get('시험캐릭터'); assert.equal(result.price.comparison, 'nearby');
  assert.deepEqual(result.price.conditions.fixed.map(rule => [rule.min, rule.max, rule.tolerance, rule.operator]), [[120, 120, 0, '='], [116, 120, 2, 'range']]);
  specialization = 120; assert.equal((await app.get('시험캐릭터')).price.meanGold, 100);
  specialization = 130; await assert.rejects(app.get('시험캐릭터'), { status: 502 });
});
test('gold expectation uses the unrounded arithmetic mean', async t => {
  const app = service({ fetchImpl: async () => response(page(1, 2, i => 1000 + i)) }); t.after(() => app.close());
  const r = await app.get('시험캐릭터');
  assert.equal(r.price.meanGold, 1000.5); assert.equal(r.costExpectedGold, 4002); assert.equal(r.price.lowSample, true);
});
test('moving counts, unexpected page numbers and replayed whole pages are discarded without cache', async t => {
  for (const kind of ['count', 'number', 'repeated', 'price-order']) {
    let calls = 0; const app = service({ fetchImpl: async (_url, init) => { calls++; const n = JSON.parse(init.body).PageNo;
      const result = page(n, 30); if (n > 1) { if (kind === 'count') result.TotalCount = 31; if (kind === 'number') result.PageNo = 1; if (kind === 'repeated') result.Items = page(1, 30).Items; if (kind === 'price-order') result.Items = page(n, 30, () => 90).Items; }
      return response(result); } }); t.after(() => app.close());
    await assert.rejects(app.get('시험캐릭터'), { status: 502 }); const before = calls;
    await assert.rejects(app.get('시험캐릭터'), { status: 502 }); assert.ok(calls > before);
  }
});
test('no listings produce null cost while transport and condition failures remain errors', async t => {
  const app = service({ fetchImpl: async () => response(page(1, 0)) }); t.after(() => app.close());
  const r = await app.get('시험캐릭터'); assert.equal(r.price.status, 'no_listings'); assert.equal(r.price.meanGold, null); assert.equal(r.costExpectedGold, null);
  const bad = service({ fetchImpl: async () => { const r = page(); r.Items[0].Grade = '유물'; return response(r); } }); t.after(() => bad.close());
  await assert.rejects(bad.get('시험캐릭터'), { status: 502 });
});
test('shared upstream429 is normalized and local per-minute request allowance is bounded', async t => {
  const shared = service({ fetchImpl: async () => { throw new GuildError(429, 'character_rate_limited'); } }); t.after(() => shared.close());
  await assert.rejects(shared.get('시험캐릭터'), { status: 429, code: 'bracelet_value_rate_limited' });
  let calls = 0, current = clock;
  const app = service({ now: () => current, upstreamPerMinute: 2, fetchImpl: async (_url, init) => { calls++; return response(page(JSON.parse(init.body).PageNo, 30)); } }); t.after(() => app.close());
  await assert.rejects(app.get('시험캐릭터'), { status: 429 }); assert.equal(calls, 2);
  for (let i = 0; i < 10; i++) assert.equal(app.allow('ip'), true); assert.equal(app.allow('ip'), false);
  current += 60001; assert.equal(app.allow('ip'), true);
});
test('response media type, size and malformed JSON are rejected', async t => {
  for (const send of [() => new Response('x'), () => new Response('{', { headers: { 'Content-Type': 'application/json' } }),
    () => new Response('x', { headers: { 'Content-Type': 'application/json', 'Content-Length': String(512 * 1024 + 1) } }),
    () => new Response(' '.repeat(512 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } })]) {
    const app = service({ fetchImpl: async () => send() }); t.after(() => app.close()); await assert.rejects(app.get('시험캐릭터'), { status: 502 });
  }
});
test('two active operations and eight waiting requests bound admission and close settles pending reads', async () => {
  const releases = [], app = service({ readDetails: name => new Promise(resolve => releases.push(() => resolve(detail(name)))) });
  const jobs = Array.from({ length: 10 }, (_, i) => app.get(`시험${i}`).catch(error => error)); await delay(1); assert.equal(releases.length, 2);
  await assert.rejects(app.get('추가시험'), { status: 429 }); app.close();
  const results = await Promise.all(jobs); assert.ok(results.every(r => r.status === 503));
  for (const release of releases) release(); await assert.rejects(app.get('시험캐릭터'), { status: 503 });
});
test('noncooperative transport timeouts keep physical concurrency charged until completion', async () => {
  const releases = []; let calls = 0;
  const app = service({ requestTimeoutMs: 15, readDetails: async name => detail(name, Number(name.slice(2)) + 90), fetchImpl: () => { calls++; return new Promise(resolve => releases.push(() => resolve(response(page())))); } });
  await Promise.all([assert.rejects(app.get('시험0'), { status: 502 }), assert.rejects(app.get('시험1'), { status: 502 })]); assert.equal(calls, 2);
  await assert.rejects(app.get('시험2'), { status: 502 }); assert.equal(calls, 2);
  app.close(); for (const release of releases) release(); await delay(1);
});
test('whole-operation expiry rejects late results and never seeds the condition cache', async t => {
  let calls = 0, late;
  const app = service({ operationTimeoutMs: 20, requestTimeoutMs: 200, fetchImpl: () => {
    calls++; return calls === 1 ? new Promise(resolve => { late = () => resolve(response(page())); }) : Promise.resolve(response(page()));
  } }); t.after(() => app.close());
  await assert.rejects(app.get('시험캐릭터'), { status: 502 }); late(); await delay(1);
  assert.equal((await app.get('시험캐릭터')).price.meanGold, 100); assert.equal(calls, 2);
});
test('one expired consumer does not cancel another consumer of the same price search', async t => {
  let release, calls = 0;
  const app = service({ operationTimeoutMs: 80, requestTimeoutMs: 200,
    readDetails: async name => { if (name === '먼저시험') await delay(30); return detail(name); },
    fetchImpl: () => { calls++; return new Promise(resolve => { release = () => resolve(response(page())); }); } }); t.after(() => app.close());
  const first = assert.rejects(app.get('먼저시험'), { status: 502 }); await delay(35);
  const second = app.get('다음시험'); await first; release();
  assert.equal((await second).status, 'ok'); assert.equal(calls, 1);
});
test('current detail identity, target hash and three-ticket scenario must all agree', async t => {
  for (const mutate of [r => r.efficiency.characterName = '다른사람', r => r.efficiency.source = 'lopec', r => r.efficiency.braceletExpectation.targetKey = 'x',
    r => r.efficiency.braceletExpectation.scenarios = [{ reconversionTickets: 1, expectedStartingBracelets: 1, successProbability: 1 }],
    r => r.efficiency.braceletExpectation.scenarios = r.efficiency.braceletExpectation.scenarios.filter(row=>row.reconversionTickets===0),
    r => r.efficiency.braceletExpectation.scenarios.push({...r.efficiency.braceletExpectation.scenarios[0]}),
    r => r.efficiency.braceletExpectation.scenarios[0].totalRolls=4,
    r => r.efficiency.braceletExpectation.scenarios[0].expectedReconversionTicketsPerBracelet=3.1,
    r => r.efficiency.braceletExpectation.scenarios[0].expectedReconversionTicketsUntilSuccess=0,
    r => delete r.efficiency.braceletExpectation.scenarios[0].expectedReconversionTicketsUntilSuccess]) {
    let calls = 0; const app = service({ readDetails: async () => { const r = detail(); mutate(r); return r; }, fetchImpl: async () => { calls++; return response(page()); } }); t.after(() => app.close());
    await assert.rejects(app.get('시험캐릭터'), { status: 502 }); assert.equal(calls, 0);
  }
});
test('an unverifiable fixed special effect is dropped and the bracelet is priced by its fixed combat stat', async t => {
  const value = detail(); const expectation = value.efficiency.braceletExpectation;
  expectation.target[0] = { fixed: true, text: '공격 및 이동 속도가 6% 증가한다.', id: 'special.attackMoveSpeed', tier: 3 };
  expectation.targetKey = createHash('sha256').update(JSON.stringify({ rarity: expectation.rarity, target: expectation.target })).digest('hex');
  const before = JSON.stringify(value); let calls = 0;
  const app = service({ readDetails: async () => value, fetchImpl: async (_url, init) => {
    calls++; const body = JSON.parse(init.body);
    assert.deepEqual(body.EtcOptions, [{ FirstOption: 2, SecondOption: 16, MinValue: 85, MaxValue: 95 }, { FirstOption: 4, SecondOption: 1, MinValue: 2, MaxValue: 2 }, { FirstOption: 4, SecondOption: 2, MinValue: 3, MaxValue: 3 }]);
    const result = page(); for (const item of result.Items) item.Options[1] = { Type: 'STAT', OptionName: '체력', Value: 5000, IsPenalty: false, IsValuePercentage: false };
    return response(result);
  } }); t.after(() => app.close());
  const r = await app.get('시험캐릭터');
  assert.equal(r.status, 'ok'); assert.equal(r.price.meanGold, 100); assert.equal(r.costExpectedGold, 400); assert.equal(r.price.availabilityOnly, undefined);
  assert.equal(r.price.relaxation, 'stats-only'); assert.equal(r.price.comparison, 'nearby'); assert.equal(calls, 1); assert.equal(r.price.coreMismatchExcludedCount, 0);
  assert.deepEqual(r.price.conditions.fixed, [{ name: '특화', operator: 'range', value: 90, min: 85, max: 95, tolerance: 5, used: true },
    { name: '공격 및 이동 속도 증가', operator: 'any', value: 6, min: null, max: null, tolerance: 0, used: false }]);
  assert.equal(r.characterName, '시험캐릭터'); assert.equal(r.targetKey, expectation.targetKey); assert.equal(JSON.stringify(value), before);
  expectation.target[0].id = 'special.unknown';
  expectation.targetKey = createHash('sha256').update(JSON.stringify({ rarity: expectation.rarity, target: expectation.target })).digest('hex');
  await assert.rejects(app.get('시험캐릭터'), { status: 502 }); assert.equal(calls, 1);
});
function mainStatDetail(name = '시험캐릭터', second = { fixed: true, text: '힘 +10000', id: 'base.mainStat', value: 10000 }) {
  const value = detail(name); const expectation = value.efficiency.braceletExpectation;
  expectation.target[1] = second;
  expectation.targetKey = createHash('sha256').update(JSON.stringify({ rarity: expectation.rarity, target: expectation.target })).digest('hex');
  return value;
}
const mainStat = body => body.EtcOptions.find(option => option.FirstOption === 1 && option.SecondOption === 11);
test('an empty exact stage falls through to an any-value main stat search that samples every page', async t => {
  const requested = []; const app = service({ readDetails: async name => mainStatDetail(name), fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body); const stat = mainStat(body); requested.push([stat.MinValue, stat.MaxValue, body.PageNo]);
    if (stat.MinValue === stat.MaxValue) return response(page(1, 0));
    const result = page(body.PageNo, 30, i => 200 + i);
    for (const item of result.Items) item.Options[2] = { Type: 'STAT', OptionName: '힘 / 민첩 / 지능', Value: 15900, IsPenalty: false, IsValuePercentage: false };
    return response(result);
  } }); t.after(() => app.close());
  const r = await app.get('시험캐릭터');
  assert.deepEqual(requested, [[10000, 10000, 1], [9600, 16000, 1], [9600, 16000, 2], [9600, 16000, 3]]);
  assert.equal(r.status, 'ok'); assert.equal(r.price.basisVersion, 'bounded-combat-v2'); assert.equal(r.price.relaxation, 'stats-only-main-any');
  assert.equal(r.price.comparison, 'nearby'); assert.equal(r.price.sampleCount, 30); assert.equal(r.price.meanGold, 214.5); assert.equal(r.costExpectedGold, 858);
  assert.deepEqual(r.price.conditions, { tier: 4, grade: '고대', fixedCount: 2, grantedCount: 3, fixed: [
    { name: '힘', operator: 'any', value: 10000, min: 9600, max: 16000, tolerance: 0, used: true },
    { name: '치명', operator: 'range', value: 90, min: 85, max: 95, tolerance: 5, used: true }] });
  const again = await app.get('시험캐릭터'); assert.equal(requested.length, 4); assert.equal(again.price.relaxation, 'stats-only-main-any'); assert.equal(again.costExpectedGold, 858);
});
test('a vitality bracelet without exact matches is priced by its combat stat alone', async t => {
  const requested = []; const app = service({ readDetails: async name => mainStatDetail(name, { fixed: true, text: '체력 +5000', id: 'base.vitality', value: 5000 }),
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body); requested.push(body.EtcOptions.map(option => option.FirstOption + ':' + option.SecondOption).join(','));
      if (body.EtcOptions.some(option => option.FirstOption === 1)) return response(page(1, 0));
      const result = page(1, 2, () => 500);
      for (const item of result.Items) item.Options[2] = { Type: 'STAT', OptionName: '체력', Value: 4100, IsPenalty: false, IsValuePercentage: false };
      return response(result);
    } }); t.after(() => app.close());
  const r = await app.get('시험캐릭터');
  assert.deepEqual(requested, ['1:6,2:15,4:1,4:2', '2:15,4:1,4:2']);
  assert.equal(r.status, 'ok'); assert.equal(r.price.relaxation, 'stats-only'); assert.equal(r.price.meanGold, 500); assert.equal(r.costExpectedGold, 2000);
  assert.deepEqual(r.price.conditions.fixed, [{ name: '체력', operator: 'any', value: 5000, min: null, max: null, tolerance: 0, used: false },
    { name: '치명', operator: 'range', value: 90, min: 85, max: 95, tolerance: 5, used: true }]);
});
test('all empty stages report no listings once and the repeat lookup hits the stage-list cache', async t => {
  let calls = 0; const app = service({ readDetails: async name => mainStatDetail(name), fetchImpl: async () => { calls++; return response(page(1, 0)); } }); t.after(() => app.close());
  const r = await app.get('시험캐릭터'); assert.equal(calls, 2);
  assert.equal(r.status, 'no_listings'); assert.equal(r.costExpectedGold, null); assert.equal(r.price.meanGold, null); assert.match(r.reason, /매물/);
  assert.equal(r.price.relaxation, 'stats-only-main-any'); assert.equal(r.price.conditions.fixed[0].operator, 'any'); assert.equal(r.price.conditions.fixed[0].used, true);
  const again = await app.get('시험캐릭터'); assert.equal(calls, 2); assert.equal(again.status, 'no_listings');
});
test('a stage that returns listings stops the relaxation walk and stage failures are not cached', async t => {
  let calls = 0; const app = service({ readDetails: async name => mainStatDetail(name), fetchImpl: async (_url, init) => {
    calls++; const body = JSON.parse(init.body);
    if (mainStat(body).MinValue !== mainStat(body).MaxValue) throw new Error('upstream');
    const result = page(1, 1, () => 700); result.Items[0].Options[2] = { Type: 'STAT', OptionName: '힘', Value: 10000, IsPenalty: false, IsValuePercentage: false };
    return response(result);
  } }); t.after(() => app.close());
  const r = await app.get('시험캐릭터'); assert.equal(calls, 1); assert.equal(r.price.relaxation, 'none'); assert.equal(r.price.comparison, 'nearby');
  assert.deepEqual(r.price.conditions.fixed.map(option => [option.name, option.operator, option.used]), [['힘', '=', true], ['치명', 'range', true]]);
  const broken = service({ readDetails: async name => mainStatDetail(name), fetchImpl: async (_url, init) => { calls++; const body = JSON.parse(init.body); if (mainStat(body).MinValue === mainStat(body).MaxValue) return response(page(1, 0)); throw new Error('upstream'); } }); t.after(() => broken.close());
  calls = 0; await assert.rejects(broken.get('시험캐릭터'), { status: 502 }); assert.equal(calls, 2);
  await assert.rejects(broken.get('시험캐릭터'), { status: 502 }); assert.equal(calls, 4);
});

function defenseDetail(name = '시험캐릭터') {
  const value = detail(name); const expectation = value.efficiency.braceletExpectation;
  expectation.target[0] = { fixed: true, text: '지능 +12000', id: 'base.mainStat', value: 12000 };
  expectation.target[1] = { fixed: true, text: '물리 방어력 +5000', id: 'special.physicalDefense', tier: 1 };
  expectation.target[3] = { fixed: false, text: '치명 +90', id: 'combat.crit', value: 90 };
  expectation.targetKey = createHash('sha256').update(JSON.stringify({ rarity: expectation.rarity, target: expectation.target })).digest('hex');
  return value;
}
const stat = (name, value) => ({ Type: 'STAT', OptionName: name, Value: value, IsPenalty: false, IsValuePercentage: false });
function defenseStage(body) {
  const main = body.EtcOptions.find(option => option.FirstOption === 1 && option.SecondOption === 11);
  return body.EtcOptions.some(option => option.FirstOption === 5) ? 'none' : main.MinValue === main.MaxValue ? 'stats-only' : 'stats-only-main-any';
}
function defensePage(PageNo, TotalCount, rows) {
  const result = page(PageNo, TotalCount, i => 1000 + i);
  result.Items.forEach((item, i) => { const [main, other] = rows(i + (PageNo - 1) * 10); item.Options[1] = stat('지능', main); item.Options[2] = other; });
  return result;
}
test('a stage whose listings all carry another core option yields no sample and hands over to the next stage', async t => {
  const requested = []; const app = service({ readDetails: async name => defenseDetail(name), fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body), stage = defenseStage(body); requested.push([stage, body.PageNo]);
    if (stage === 'none') return response(page(1, 0));
    if (stage === 'stats-only') return response(defensePage(body.PageNo, 12, () => [12000, stat('특화', 100)]));
    return response(defensePage(body.PageNo, 3, i => [15000, i === 1 ? stat('치명', 95) : stat('체력', 4100)]));
  } }); t.after(() => app.close());
  const r = await app.get('시험캐릭터');
  assert.deepEqual(requested, [['none', 1], ['stats-only', 1], ['stats-only', 2], ['stats-only-main-any', 1]]);
  assert.equal(r.status, 'ok'); assert.equal(r.price.relaxation, 'stats-only-main-any'); assert.equal(r.price.basisVersion, 'bounded-combat-v2');
  assert.equal(r.price.sampleCount, 2); assert.equal(r.price.meanGold, 1001); assert.equal(r.price.coreMismatchExcludedCount, 1); assert.equal(r.price.filteredCount, 0);
  assert.equal(r.costExpectedGold, 4004); assert.equal(r.price.comparison, 'nearby');
  assert.deepEqual(r.price.conditions.fixed, [{ name: '지능', operator: 'any', value: 12000, min: 9600, max: 16000, tolerance: 0, used: true },
    { name: '물리 방어력', operator: 'any', value: 5000, min: null, max: null, tolerance: 0, used: false }]);
  await app.get('시험캐릭터'); assert.equal(requested.length, 4);
});
test('listings that never yield a sample in any stage end as no listings with the last stage conditions', async t => {
  const requested = []; const app = service({ readDetails: async name => defenseDetail(name), fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body), stage = defenseStage(body); requested.push([stage, body.PageNo]);
    return response(stage === 'none' ? page(1, 0) : defensePage(body.PageNo, 1, () => [stage === 'stats-only' ? 12000 : 9700, stat('신속', 80)]));
  } }); t.after(() => app.close());
  const r = await app.get('시험캐릭터');
  assert.deepEqual(requested, [['none', 1], ['stats-only', 1], ['stats-only-main-any', 1]]);
  assert.equal(r.status, 'no_listings'); assert.equal(r.costExpectedGold, null); assert.equal(r.price.meanGold, null);
  assert.equal(r.price.relaxation, 'stats-only-main-any'); assert.equal(r.price.coreMismatchExcludedCount, 1); assert.equal(r.price.totalCount, 1);
  assert.equal(r.price.conditions.fixed[1].used, false); await app.get('시험캐릭터'); assert.equal(requested.length, 3);
});
test('a moved page count inside a later stage still fails the whole lookup', async t => {
  let calls = 0; const app = service({ readDetails: async name => defenseDetail(name), fetchImpl: async (_url, init) => {
    calls++; const body = JSON.parse(init.body), stage = defenseStage(body);
    if (stage !== 'stats-only') return response(page(1, 0));
    const result = defensePage(body.PageNo, 12, () => [12000, stat('체력', 4100)]); if (body.PageNo > 1) result.TotalCount = 13; return response(result);
  } }); t.after(() => app.close());
  await assert.rejects(app.get('시험캐릭터'), { status: 502 }); assert.equal(calls, 3);
});

const replacementItem = (price, index = 0) => ({ Name: '찬란한 구원자의 팔찌', Grade: '고대', Tier: 4,
  Options: [{ Type: 'STAT', OptionName: '치명', Value: 70, IsPenalty: false, IsValuePercentage: false }],
  AuctionInfo: { BuyPrice: price, EndDate: `2026-09-17T12:${String(Math.floor(index / 60) % 60).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000` } });
const replacementPage = (PageNo, TotalCount, price = () => 500) => ({ PageNo, PageSize: 10, TotalCount,
  Items: Array.from({ length: Math.max(0, Math.min(10, TotalCount - (PageNo - 1) * 10)) }, (_, i) => replacementItem(price((PageNo - 1) * 10 + i), (PageNo - 1) * 10 + i)) });

test('a bracelet the model cannot price falls back to its own stat lines, then to the grade average', async t => {
  const bodies = [], app = service({ fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body); bodies.push(body);
    // Only the stage without any effect filter finds listings.
    return response(body.EtcOptions.length ? replacementPage(body.PageNo, 0) : replacementPage(body.PageNo, 4));
  } }); t.after(() => app.close());
  const result = await app.replacement({ tier: 4, grade: '고대', stats: [{ name: '치명', value: 70 }, { name: '특화', value: 100 }] });
  assert.equal(result.status, 'ok'); assert.equal(result.basis, 'bracelet_market_average');
  assert.equal(result.meanGold, 500); assert.equal(result.sampleCount, 4);
  assert.match(result.targetKey, /^[a-f0-9]{64}$/); assert.equal(result.checkedAt, clock);
  assert.deepEqual(result.conditions, { tier: 4, grade: '고대', fixed: [] });
  assert.deepEqual(bodies.map(body => body.EtcOptions.length), [2, 1, 0]);
  assert.ok(bodies.every(body => body.CategoryCode === 200040 && body.ItemTier === 4 && body.ItemGrade === '고대'));
  // The whole ladder is shared, so a second bracelet of the same grade costs no request at all.
  const again = await app.replacement({ tier: 4, grade: '고대', stats: [{ name: '치명', value: 70 }, { name: '특화', value: 100 }] });
  assert.equal(again.meanGold, 500); assert.equal(bodies.length, 3);
});

test('a matching stat search stops the replacement ladder and unsupported bracelets never reach the market', async t => {
  let calls = 0;
  const app = service({ fetchImpl: async (_url, init) => { calls++; return response(replacementPage(JSON.parse(init.body).PageNo, 3)); } });
  t.after(() => app.close());
  const result = await app.replacement({ tier: 4, grade: '고대', stats: [{ name: '치명', value: 70 }] });
  assert.equal(result.status, 'ok'); assert.equal(result.basis, 'bracelet_replacement_relaxed'); assert.equal(calls, 1);
  assert.deepEqual(result.conditions.fixed.map(row => [row.name, row.min, row.max]), [['치명', 65, 75]]);
  const unsupported = await app.replacement({ tier: 4, grade: '전설', stats: [] });
  assert.equal(unsupported.status, 'unavailable'); assert.equal(unsupported.meanGold, null); assert.equal(calls, 1);
});
