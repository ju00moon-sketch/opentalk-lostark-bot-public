import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { approvedRequester } from './helpers/access.js';
import { createWebServer } from '../src/server.js';

const name = '시험캐릭터';
const bracelet = { Type: '팔찌', Name: '시험용 고대 팔찌', Grade: '고대', Tooltip: JSON.stringify({
  title: { type: 'ItemTitle', value: { leftStr2: '아이템 티어 4' } },
  effects: { type: 'ItemPartBox', value: { Element_000: '팔찌 효과', Element_001:
    [['locked', '치명 +90'], ['locked', '특화 +90'], ['changeable', '민첩 +12000'], ['changeable', '체력 +5000']]
      .map(([marker, text]) => `<img src='emoticon_tooltip_bracelet_${marker}'></img>${text}`).join('<BR>') } },
}) };
const raw = { ArmoryProfile: { CharacterName: name, CharacterClassName: '블레이드', ServerName: '루페온', ItemAvgLevel: '1,740.00' },
  ArmoryEquipment: [bracelet], ArmoryGem: { Gems: [], Effects: null }, ArmoryEngraving: { ArkPassiveEffects: [] },
  ArkPassive: { IsArkPassive: false, Points: [], Effects: [] }, ArkGrid: { Slots: [], Effects: [] } };
function auction() {
  return { PageNo: 1, PageSize: 10, TotalCount: 2, Items: [1000, 1001].map(BuyPrice => ({
    Name: '시험용 고대 팔찌', Tier: 4, Grade: '고대',
    AuctionInfo: { BuyPrice, TradeAllowCount: 0, IsCompetitive: false, EndDate: new Date(Date.now() + 86400000).toISOString() },
    Options: [{ Type: 'BRACELET_RANDOM_SLOT', OptionName: '부여 효과 수량', Value: 2, IsValuePercentage: false },
      ...['치명', '특화'].map(OptionName => ({ Type: 'STAT', OptionName, Value: 90, IsValuePercentage: false }))],
  })) };
}
async function fixture(t, auctionHook = async () => {}) {
  const directory = await mkdtemp(join(tmpdir(), 'bracelet-value-http-')), dbPath = join(directory, 'state.sqlite');
  const calls = [];
  const app = createWebServer({ config: { origin: 'https://opentalk.example.invalid', host: '127.0.0.1', port: 0,
    dbPath, providers: {}, automaticApproval: { lostArkApiKey: 'synthetic-game-key' } },
    fetchImpl: async (url, init) => {
      assert.equal(new URL(url).origin, 'https://developer-lostark.game.onstove.com');
      assert.equal(init.headers.Authorization, 'bearer synthetic-game-key'); calls.push(new URL(url).pathname);
      if (url.endsWith('/auctions/items')) { await auctionHook(); return Response.json(auction()); }
      return Response.json(raw);
    } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  return { request: approvedRequester(dbPath), dbPath, calls, base: 'http://127.0.0.1:' + app.server.address().port,
    path: '/api/character/bracelet-value?' + new URLSearchParams({ name }) };
}

test('bracelet valuation HTTP is public, validates request shape before work, shares details and returns no-store', async t => {
  const h = await fixture(t);
  assert.equal((await fetch(h.base + '/api/character/bracelet-value?name=가')).status, 400); assert.equal(h.calls.length, 0);
  for (const suffix of ['?name=가', '?name=시험캐릭터&name=다른사람', '?name=시험캐릭터&price=1']) {
    assert.equal((await h.request(h.base + '/api/character/bracelet-value' + suffix)).status, 400);
  }
  assert.equal((await h.request(h.base + h.path, { method: 'POST' })).status, 405);
  for (const headers of [{ Origin: 'https://other.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await h.request(h.base + h.path, { headers })).status, 403);
  }
  assert.equal(h.calls.length, 0);
  const [response, detailsResponse] = await Promise.all([h.request(h.base + h.path), h.request(h.base + '/api/character/spec?' + new URLSearchParams({ name, section: 'details' }))]);
  const body = await response.json(), details = await detailsResponse.json();
  assert.equal(response.status, 200, JSON.stringify({ body, details, calls: h.calls })); assert.equal(detailsResponse.status, 200);
  assert.equal(body.targetKey, details.efficiency.braceletExpectation.targetKey);
  assert.equal(body.price.meanGold, 1000.5); assert.equal(body.price.lowSample, true);
  assert.equal(body.reconversionTickets, 3); assert.equal(body.totalRolls,7); assert.equal(body.costExpectedGold, 1000.5 * body.expectedStartingBracelets);
  assert(body.expectedReconversionTicketsPerBracelet>0 && body.expectedReconversionTicketsPerBracelet<3);
  assert.equal(body.expectedReconversionTicketsUntilSuccess,body.expectedReconversionTicketsPerBracelet*body.expectedStartingBracelets);
  assert.equal(body.reconversionTicketUnitGold,null);assert.equal(body.reconversionTicketCostGold,null);
  assert.equal(body.price.samplingMethod, 'all-listings');
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('set-cookie'), null);
  assert(!JSON.stringify(body).includes('synthetic-game-key'));
  assert.equal(h.calls.filter(p => p === '/auctions/items').length, 1); assert.equal(h.calls.length, 2);
  assert.equal((await h.request(h.base + h.path)).status, 200); assert.equal(h.calls.length, 2);
});

test('a session removed during a pending bracelet auction reply does not block the public answer', { timeout: 5000 }, async t => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const h = await fixture(t, async () => { entered(); await gate; });
  const pending = h.request(h.base + h.path); await started;
  const db = new DatabaseSync(h.dbPath);
  try { db.exec('DELETE FROM sessions'); } finally { db.close(); }
  release(); const response = await pending;
  assert.equal(response.status, 200, 'public lookup keeps answering after the session is gone');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
