import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBraceletReplacementPlan, normalizeBraceletReplacementAuction, BRACELET_REPLACEMENT_BASIS } from '../src/bracelet-replacement-search.js';

const stats = [{ name: '치명', value: 70 }, { name: '특화', value: 100 }, { name: '힘', value: 8000 }];
const listing = (BuyPrice, extra = {}) => ({ Name: '찬란한 구원자의 팔찌', Grade: '고대', Tier: 4,
  Options: stats.map(stat => ({ Type: 'STAT', OptionName: stat.name, Value: stat.value, IsPenalty: false, IsValuePercentage: false })),
  AuctionInfo: { BuyPrice, EndDate: '2099-01-01T00:00:00' }, ...extra });
const page = (items, TotalCount = items.length, PageNo = 1) => ({ PageNo, PageSize: 10, TotalCount, Items: items });

test('the ladder keeps the strongest combat and main stat lines, then drops them down to the bare grade', () => {
  const plan = buildBraceletReplacementPlan({ tier: 4, grade: '고대', stats });
  assert.equal(plan.status, 'ok');
  assert.equal(plan.stages.length, 3);
  assert.match(plan.targetKey, /^[a-f0-9]{64}$/);
  // Combat stats identify a bracelet, so they come before the main stat and the stronger one first.
  assert.deepEqual(plan.stages[0].conditions.map(row => [row.name, row.min, row.max]), [['특화', 95, 105], ['치명', 65, 75]]);
  assert.deepEqual(plan.stages[0].body.EtcOptions, [
    { FirstOption: 2, SecondOption: 16, MinValue: 95, MaxValue: 105 },
    { FirstOption: 2, SecondOption: 15, MinValue: 65, MaxValue: 75 }]);
  assert.deepEqual(plan.stages.map(stage => stage.rules.length), [2, 1, 0]);
  assert.deepEqual(plan.stages.map(stage => stage.basis),
    [BRACELET_REPLACEMENT_BASIS[0], BRACELET_REPLACEMENT_BASIS[0], BRACELET_REPLACEMENT_BASIS[1]]);
  assert.equal(new Set(plan.stages.map(stage => stage.fingerprint)).size, 3);
  for (const stage of plan.stages) {
    assert.equal(stage.body.CategoryCode, 200040); assert.equal(stage.body.ItemTier, 4);
    assert.equal(stage.body.ItemGrade, '고대'); assert.equal(stage.body.ItemName, '');
    assert.equal(stage.body.ItemGradeQuality, null);
  }
});

test('a bracelet whose stat lines are unusable still reaches the grade average, and unsupported input never does', () => {
  const bare = buildBraceletReplacementPlan({ tier: 3, grade: '유물', stats: [{ name: '무기 공격력', value: 7200 }] });
  assert.equal(bare.status, 'ok');
  assert.deepEqual(bare.stages.map(stage => stage.basis), [BRACELET_REPLACEMENT_BASIS[1]]);
  assert.equal(bare.stages[0].body.EtcOptions.length, 0);
  for (const input of [undefined, {}, { tier: 5, grade: '고대', stats }, { tier: 4, grade: '전설', stats },
    { tier: 4, grade: '고대', stats: 'x' }, { tier: 4, grade: '고대', stats: Array.from({ length: 17 }, () => ({ name: '치명', value: 1 })) }]) {
    assert.equal(buildBraceletReplacementPlan(input).status, 'unavailable');
  }
  // A stat without a usable amount is skipped rather than turned into a filter.
  const skipped = buildBraceletReplacementPlan({ tier: 4, grade: '고대', stats: [{ name: '치명', value: null }, { name: '특화', value: 80 }] });
  assert.deepEqual(skipped.stages[0].conditions.map(row => row.name), ['특화']);
});

test('only purchasable listings of the requested tier and grade are sampled, in ascending price order', () => {
  const search = buildBraceletReplacementPlan({ tier: 4, grade: '고대', stats }).stages[0];
  const now = Date.parse('2026-09-19T00:00:00+09:00');
  const ok = normalizeBraceletReplacementAuction(page([listing(100), listing(0), listing(null), listing(300)]), search, { now });
  assert.equal(ok.status, 'ok');
  assert.deepEqual(ok.samples.map(row => row.price), [100, 300]);
  assert.equal(ok.excludedCount, 2); assert.equal(ok.checkedCount, 4); assert.equal(ok.totalCount, 4);
  assert.equal(normalizeBraceletReplacementAuction(page([], 0), search, { now }).status, 'no_listings');
  assert.equal(normalizeBraceletReplacementAuction({ PageNo: 1, PageSize: 10, TotalCount: 0, Items: null }, search, { now }).status, 'no_listings');
  for (const [response, reason] of [
    [page([listing(300), listing(100)]), 'auction_sort_invalid'],
    [page([listing(100, { Tier: 3 })]), 'filter_mismatch'],
    [page([listing(100, { Grade: '유물' })]), 'filter_mismatch'],
    [page([listing(100, { Name: '고대 목걸이' })]), 'filter_mismatch'],
    [page([{ ...listing(100), AuctionInfo: { BuyPrice: 100, EndDate: 'soon' } }]), 'auction_end_invalid'],
    [page([listing(100)], 3), 'auction_response_invalid'],
    [{ PageNo: 1, PageSize: 20, TotalCount: 1, Items: [listing(100)] }, 'auction_response_invalid'],
  ]) {
    const result = normalizeBraceletReplacementAuction(response, search, { now });
    assert.equal(result.status, 'unavailable'); assert.equal(result.reason, reason);
  }
  // An expired listing is not a purchase.
  assert.deepEqual(normalizeBraceletReplacementAuction(page([listing(100)]), search,
    { now: Date.parse('2100-01-01T00:00:00+09:00') }).samples, []);
});
