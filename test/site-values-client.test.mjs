import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createSiteValues } from '../src/site-valuation.js';

// A stand-in for the web service's loopback bot endpoint (README.md).
const TOKEN = 'a'.repeat(40);
const requests = [];
let mode = 'done';
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  requests.push({ path: url.pathname, name: url.searchParams.get('name'), parts: url.searchParams.get('parts'), token: request.headers['x-bot-token'] });
  const send = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)); };
  if (url.pathname !== '/internal/bot/character-values' || request.headers['x-bot-token'] !== TOKEN) return send(404, { error: 'not_found' });
  if (mode === 'hang') { await new Promise((resolve) => setTimeout(resolve, 400)); return send(200, {}); }
  const parts = (url.searchParams.get('parts') || 'efficiency,valuation').split(',');
  const body = { characterName: url.searchParams.get('name'), updatedAt: 1 };
  if (parts.includes('efficiency')) body.efficiency = { bracelet: { status: 'ok', efficiency: 15.62 }, gem: { status: 'ok', efficiency: 9.41, optionEfficiency: 6.71, pointEfficiency: 2.52, effectEfficiencies: [] } };
  if (parts.includes('valuation')) {
    body.valuation = mode === 'running' ? { status: 'running' }
      : mode === 'partial' ? { status: 'done', bracelet: { gold: null, record: false, reason: 'no_matching_listings' }, gems: { gold: null, knownGold: 500000, items: 6, known: 4, reason: 'partial' } }
      : { status: 'done', bracelet: { gold: 30443366.4, record: true, reason: null }, gems: { gold: 456649941.45, knownGold: 456649941.45, items: 24, known: 24, reason: null } };
  }
  if (parts.includes('spec')) body.spec = { status: 'ok', profile: { characterName: url.searchParams.get('name') }, score: { score: 9737.47, role: 'dealer' }, omitted: [], tier: { key: 'esther', name: '에스더', status: 'ok', basis: 'lopec', percentile: 0.001, source: '로펙 DB', reason: null, reference: null }, record: null, bracelet: { status: 'ok', efficiency: 16.16 }, gem: { status: 'ok', efficiency: 14.25 } };
  send(200, body);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());
test.beforeEach(() => { requests.length = 0; mode = 'done'; });

test('efficiency and valuation are separate token-bearing requests mapped to the command shapes', async () => {
  const site = createSiteValues({ base, token: TOKEN });
  const [efficiency, valuation] = await Promise.all([site.getSiteEfficiency('합성캐릭터4'), site.getSiteValuation('합성캐릭터4')]);
  assert.deepEqual(efficiency.bracelet, { status: 'ok', efficiency: 15.62 });
  assert.equal(efficiency.gem.efficiency, 9.41);
  assert.deepEqual(valuation, { status: 'done', bracelet: { gold: 30443366.4, record: true, reason: null },
    gems: { gold: 456649941.45, knownGold: 456649941.45, items: 24, known: 24, reason: null } });
  assert.deepEqual(requests.map((r) => [r.path, r.name, r.parts, r.token === TOKEN]).sort(),
    [['/internal/bot/character-values', '합성캐릭터4', 'efficiency', true], ['/internal/bot/character-values', '합성캐릭터4', 'valuation', true]]);
});

test('running, partial and failed answers keep the commands usable', async () => {
  const site = createSiteValues({ base, token: TOKEN });
  mode = 'running';
  assert.equal((await site.getSiteValuation('합성캐릭터4')).status, 'running');
  mode = 'partial';
  const partial = await site.getSiteValuation('합성캐릭터4');
  assert.equal(partial.status, 'done');
  assert.deepEqual(partial.bracelet, { gold: null, record: false, reason: 'no_matching_listings' });
  assert.deepEqual(partial.gems, { gold: null, knownGold: 500000, items: 6, known: 4, reason: 'partial' });
  const wrong = createSiteValues({ base, token: 'b'.repeat(40) });
  assert.equal(await wrong.getSiteEfficiency('합성캐릭터4'), null);
  assert.equal((await wrong.getSiteValuation('합성캐릭터4')).status, 'unavailable');
});

test('a slow site reads as still calculating while no token or no site reads as unavailable', async () => {
  mode = 'hang';
  const slow = createSiteValues({ base, token: TOKEN, valuationTimeoutMs: 50, efficiencyTimeoutMs: 50 });
  assert.equal((await slow.getSiteValuation('합성캐릭터4')).status, 'running');
  assert.equal(await slow.getSiteEfficiency('합성캐릭터4'), null);
  const none = createSiteValues({ base, token: undefined });
  assert.equal((await none.getSiteValuation('합성캐릭터4')).status, 'unavailable');
  assert.equal(await none.getSiteEfficiency('합성캐릭터4'), null);
  assert.equal(requests.filter((r) => r.token === undefined).length, 0);
  const down = createSiteValues({ base: 'http://127.0.0.1:9', token: TOKEN });
  assert.equal((await down.getSiteValuation('합성캐릭터4')).status, 'unavailable');
});

test('the spec part is one request of its own and a slow or absent site reads as running or unavailable', async () => {
  const site = createSiteValues({ base, token: TOKEN });
  const spec = await site.getSiteSpec('합성예제');
  assert.equal(spec.status, 'ok'); assert.equal(spec.tier.key, 'esther'); assert.equal(spec.score.score, 9737.47);
  assert.deepEqual(requests.map((r) => [r.name, r.parts, r.token === TOKEN]), [['합성예제', 'spec', true]]);
  mode = 'hang';
  assert.deepEqual(await createSiteValues({ base, token: TOKEN, valuationTimeoutMs: 50 }).getSiteSpec('합성예제'), { status: 'running' });
  assert.equal(await createSiteValues({ base, token: 'b'.repeat(40) }).getSiteSpec('합성예제'), null);
  assert.equal(await createSiteValues({ base, token: undefined }).getSiteSpec('합성예제'), null);
});

