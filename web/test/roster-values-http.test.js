import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createWebServer } from '../src/server.js';
import { createRosterValueRecordStore } from '../src/roster-value-record-store.js';
import { BOT_ROSTER_VALUES_PATH, BOT_ROSTER_VALUES_REFRESH_PATH } from '../src/roster-values.js';

const TOKEN = 'r'.repeat(48);
const key = name => Buffer.from(name).toString('hex').padEnd(64, '0').slice(0, 64);
const aggregate = (characterName, market, expected, bookGold = 1000000) => ({ characterName, serverName: '루페온',
  components: { engravings: { items: [{ status: 'ok', accountKey: 'engraving:질풍', grade: '유물', level: 3,
    marketReplacementGold: bookGold, checkedAt: 1, reason: null }], counts: { items: 1, known: 1, unknown: 0 } } },
  excludingSharedBooks: { knownMarketReplacementGold: market, knownExpectedAcquisitionGold: expected, complete: true } });
const row = (characterName, itemLevel, market, expected, at) => ({ serverName: '루페온', itemLevel, role: 'dealer',
  targetKey: key(characterName), equipmentUpdatedAt: at, status: 'ok', knownGold: market + expected,
  knownMarketGold: market, knownExpectedGold: expected, complete: true, unknownItems: 0,
  aggregate: aggregate(characterName, market, expected), computedAt: at });

// The armory the loopback routes see: one 1,740 character with nothing equipped, so a real refresh finishes
// without any market lookup and stores a zero valuation instead of a fixture.
const armory = { ArmoryProfile: { CharacterName: '테스트캐릭터', CharacterClassName: '블레이드', ServerName: '루페온', ItemAvgLevel: '1,740.00' },
  ArmoryEquipment: [], ArmoryGem: { Gems: [], Effects: null }, ArmoryEngraving: { ArkPassiveEffects: [] },
  ArkPassive: { IsArkPassive: false, Points: [], Effects: [] }, ArkGrid: { Slots: [], Effects: [] } };
const fetchImpl = async url => {
  const path = new URL(url).pathname;
  assert.equal(new URL(url).origin, 'https://developer-lostark.game.onstove.com');
  if (path.endsWith('/profiles')) return Response.json(armory.ArmoryProfile);
  if (path.endsWith('/siblings')) return Response.json([armory.ArmoryProfile]);
  if (path.endsWith('/arkgrid')) return Response.json({ Slots: [] });
  return Response.json(armory);
};

test('the roster value routes answer only a loopback request with the shared token', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'roster-values-http-'));
  const dbPath = join(directory, 'auth.sqlite');
  const at = Date.now() - 60000;
  const seed = createRosterValueRecordStore(`${dbPath}.roster-values.sqlite`, {});
  seed.recordRoster('앞으로가나', { serverName: '루페온', members: [
    { characterName: '앞으로가나', serverName: '루페온', itemLevel: 1740 },
    { characterName: '부캐하나', serverName: '루페온', itemLevel: 1725 },
    { characterName: '저렙부캐', serverName: '루페온', itemLevel: 1700 }] });
  seed.recordCharacter('앞으로가나', row('앞으로가나', 1740, 3000000, 2000000, at));
  seed.recordCharacter('부캐하나', row('부캐하나', 1725, 1000000, 500000, at));
  seed.recordRoster('합성캐릭터4', { serverName: '루페온', members: [{ characterName: '합성캐릭터4', serverName: '루페온', itemLevel: 1745 }] });
  seed.close();

  const app = createWebServer({ config: { origin: 'https://opentalk.example.invalid', host: '127.0.0.1', port: 0, dbPath,
    providers: {}, automaticApproval: { lostArkApiKey: 'synthetic-game-key' }, botInternalToken: TOKEN }, fetchImpl, readLopecScore: async () => null });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = (path, { headers = {}, method = 'GET', body } = {}) => fetch(`${base}${path}`, { method, headers, body });
  const authorized = (path, options = {}) => call(path, { ...options, headers: { 'X-Bot-Token': TOKEN, ...options.headers } });

  assert.equal((await call(`${BOT_ROSTER_VALUES_PATH}?names=앞으로가나`)).status, 404);
  assert.equal((await call(`${BOT_ROSTER_VALUES_PATH}?names=앞으로가나`, { headers: { 'X-Bot-Token': `${TOKEN.slice(0, 47)}x` } })).status, 404);
  assert.equal((await authorized(BOT_ROSTER_VALUES_PATH, { method: 'POST' })).status, 405);
  assert.equal((await authorized(`${BOT_ROSTER_VALUES_PATH}?names=앞으로가나&extra=1`)).status, 400);
  assert.equal((await authorized(`${BOT_ROSTER_VALUES_PATH}?names=앞으로가나,앞으로가나`)).status, 400);
  assert.equal((await authorized(`${BOT_ROSTER_VALUES_REFRESH_PATH}?names=앞으로가나`)).status, 400);

  // The stored rows are re-aggregated on every read, so the engraving book is still counted once per server.
  const response = await authorized(`${BOT_ROSTER_VALUES_PATH}?names=앞으로가나,합성캐릭터4,없는앵커`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['anchors', 'updatedAt']);
  const [mine, other, missing] = body.anchors;
  assert.equal(mine.characterName, '앞으로가나');
  assert.equal(mine.status, 'ok');
  // Every anchor carries the 원정대 최고 기록 beside the current value; nothing has set one here yet.
  assert.deepEqual(Object.keys(mine).sort(), ['aggregate', 'characterName', 'computedAt', 'record', 'roster', 'status']);
  assert.deepEqual(mine.record, { status: 'missing', knownGold: null, recordedAt: null, repricedAt: null,
    counts: { characters: 0, knownCharacters: 0, dealers: 0, supports: 0 }, members: [] });
  assert.deepEqual(mine.aggregate, { knownGold: 7500000, complete: true, engravingBooksGold: 1000000, estimatedItems: 0,
    counts: { characters: 2, knownCharacters: 2, unknownCharacters: 0, estimatedCharacters: 0 } });
  assert.deepEqual(mine.roster.characters, [
    { characterName: '앞으로가나', serverName: '루페온', itemLevel: 1740, role: 'dealer', status: 'ok', knownGold: 5000000 },
    { characterName: '부캐하나', serverName: '루페온', itemLevel: 1725, role: 'dealer', status: 'ok', knownGold: 1500000 },
    { characterName: '저렙부캐', serverName: '루페온', itemLevel: 1700, role: null, status: 'missing', knownGold: null }]);
  assert.deepEqual(mine.computedAt, { oldest: at, newest: at });
  assert.equal(other.status, 'missing');
  assert.equal(other.aggregate.counts.characters, 1);
  assert.equal(missing.status, 'missing');
  assert.equal(missing.roster, null);

  // Anchors without a usable stored value are queued for the next run without holding up the answer.
  const queued = await (await authorized(BOT_ROSTER_VALUES_REFRESH_PATH)).json();
  assert.equal(queued.running, false);
  assert.equal(queued.queued, 1);
  assert.equal(queued.lastSuccessAt, null);

  const post = await authorized(BOT_ROSTER_VALUES_REFRESH_PATH, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ names: ['테스트캐릭터'] }) });
  assert.equal(post.status, 200);
  assert.equal((await post.json()).status, 'started');
  let status = null;
  for (let attempt = 0; attempt < 200; attempt++) {
    status = await (await authorized(BOT_ROSTER_VALUES_REFRESH_PATH)).json();
    if (!status.running) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(status.running, false);
  // The queued anchor from the read above joins the requested one; its roster lookup fails and is only counted.
  assert.equal(status.run.anchors, 2);
  assert.equal(status.run.calculated, 1, JSON.stringify(status.run));
  assert.equal(status.run.rostersFailed, 1);
  assert.equal(status.queued, 0);
  assert.equal(typeof status.lastSuccessAt, 'number');
  const refreshed = (await (await authorized(`${BOT_ROSTER_VALUES_PATH}?names=테스트캐릭터`)).json()).anchors[0];
  assert.equal(refreshed.status, 'ok');
  assert.equal(refreshed.aggregate.counts.characters, 1);
  assert.equal(refreshed.roster.characters[0].itemLevel, 1740);

  for (const bad of ['{}', JSON.stringify({ names: [] })]) {
    const response = await authorized(BOT_ROSTER_VALUES_REFRESH_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bad });
    assert.equal(response.status, 400);
  }
  let limited = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    const response = await authorized(BOT_ROSTER_VALUES_REFRESH_PATH, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ names: ['테스트캐릭터'] }) });
    if (response.status === 429) limited++;
    await response.json();
  }
  assert.ok(limited > 0, 'the refresh route keeps its own per-minute limit');

  // The public routes never open through the bot token.
  assert.equal((await call('/api/lounge', { headers: { 'X-Bot-Token': TOKEN } })).status, 401);
});

test('the routes stay closed when no bot token is configured', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'roster-values-silent-'));
  const app = createWebServer({ config: { origin: 'https://opentalk.example.invalid', host: '127.0.0.1', port: 0,
    dbPath: join(directory, 'auth.sqlite'), providers: {}, automaticApproval: { lostArkApiKey: 'synthetic-game-key' } },
    fetchImpl, readLopecScore: async () => null });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  for (const path of [`${BOT_ROSTER_VALUES_PATH}?names=앞으로가나`, BOT_ROSTER_VALUES_REFRESH_PATH]) {
    const response = await fetch(`${base}${path}`, { headers: { 'X-Bot-Token': TOKEN } });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, 'not_found');
  }
});

test('a roster valuation opened on the website fills the same durable store', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'roster-values-page-'));
  const app = createWebServer({ config: { origin: 'https://opentalk.example.invalid', host: '127.0.0.1', port: 0,
    dbPath: join(directory, 'auth.sqlite'), providers: {}, automaticApproval: { lostArkApiKey: 'synthetic-game-key' }, botInternalToken: TOKEN },
    fetchImpl, readLopecScore: async () => null });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;

  let page = null;
  for (let attempt = 0; attempt < 200; attempt++) {
    page = await (await fetch(`${base}/api/character/valuation?name=테스트캐릭터&scope=roster`)).json();
    if (page.status === 'done') break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(page.status, 'done');
  // The display contract is untouched: the page answer is the same envelope it has always been.
  assert.deepEqual(Object.keys(page).sort(), ['aggregate', 'characterName', 'characters', 'gemValuation', 'progress', 'scope', 'status', 'updatedAt']);

  let stored = null;
  for (let attempt = 0; attempt < 200; attempt++) {
    stored = (await (await fetch(`${base}${BOT_ROSTER_VALUES_PATH}?names=테스트캐릭터`, { headers: { 'X-Bot-Token': TOKEN } })).json()).anchors[0];
    if (stored.status === 'ok' && stored.computedAt) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(stored.status, 'ok');
  assert.equal(stored.aggregate.counts.characters, 1);
  assert.equal(stored.roster.characters[0].characterName, '테스트캐릭터');
  assert.ok(Number.isSafeInteger(stored.computedAt.newest));
});
