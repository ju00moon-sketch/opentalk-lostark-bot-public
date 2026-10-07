import { approvedRequester } from './helpers/access.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createCharacterSpecService, normalizeCombatStats } from '../src/character-spec.js';
import { createWebServer } from '../src/server.js';
import { findCharacterProfile } from '../src/character-profile.js';

const name = '테스트바드';
const characterImage = 'https://cdn-lostark.game.onstove.com/armory/4/ABCDEF0123456789.jpg?v=20260913225030';
const profile = (characterName = name) => ({ CharacterName: characterName, ServerName: '루페온', CharacterClassName: '바드',
  ItemAvgLevel: '1,740.83', CombatPower: '5,123.45', ExpeditionLevel: 300, Title: '반가운 친구', GuildName: '포근해', CharacterImage: characterImage });
const config = { automaticApproval: { lostArkApiKey: 'synthetic-game-key' } };
const isError = (status, code) => error => error.status === status && error.code === code;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture(t, options = {}) {
  let timestamp = 1790000000000;
  const calls = [];
  const control = { mode: 'normal', hook: null, headers: {}, zeroLevel: false };
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://developer-lostark.game.onstove.com');
    assert.equal(init.headers.Authorization, 'bearer synthetic-game-key');
    assert.equal(init.redirect, 'error');
    assert.equal(init.method, 'GET');
    calls.push(parsed);
    if (control.hook) await control.hook(init.signal);
    if (control.mode === 'null') return Response.json(null);
    if (control.mode.startsWith('http')) return Response.json({ error: 'private upstream message' }, { status: Number(control.mode.slice(4)), headers: control.headers });
    if (control.mode === 'html') return new Response('<html>private error</html>', { headers: { 'Content-Type': 'text/html' } });
    if (control.mode === 'invalid') return Response.json({ bogus: true });
    if (control.mode === 'oversize') return new Response(' '.repeat(3 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } });
    const character = decodeURIComponent(parsed.pathname.split('/')[3] || name);
    if (parsed.pathname.endsWith('/profiles')) return Response.json(profile(character), { headers: control.headers });
    if (parsed.pathname.endsWith('/siblings')) return Response.json([
      profile(name), { ...profile('다른바드'), ItemAvgLevel: '1,700.00' }, { ...profile('다른서버'), ServerName: '카제로스' },
      ...(control.zeroLevel ? [{ ...profile('장비없는캐릭터'), CharacterClassName: '전사(여)', ItemAvgLevel: '0.00' }] : []),
    ], { headers: control.headers });
    if (parsed.pathname.endsWith('/arkgrid')) {
      if (control.mode === 'bad-grid') return Response.json({ Slots: [{ Grade: '고대', Point: -1 }] });
      if (character === '다른바드') return Response.json({ Slots: [] });
      return Response.json({ Slots: [{ Index: 0, Grade: '고대', Point: 20 }] }, { headers: control.headers });
    }
    if (control.armory) return Response.json(control.armory);
    return Response.json({ ArmoryProfile: profile(character), ArmoryEquipment: [], ArmoryGem: { Gems: [], Effects: null },
      ArmoryEngraving: { ArkPassiveEffects: [] }, ArkPassive: { IsArkPassive: false, Points: [], Effects: [] } });
  };
  const service = createCharacterSpecService({ config, fetchImpl, now: () => timestamp, ...options });
  t.after(() => service.close());
  return { service, calls, control, fetchImpl, now: () => timestamp, advance: ms => { timestamp += ms; } };
}

test('public profile is structured, bounded, and shares normalized in-flight work with five-minute cache', async t => {
  const f = fixture(t);
  const gate = deferred();
  f.control.hook = () => gate.promise;
  const a = f.service.get(' TestBard ', 'profile');
  const b = f.service.get('testbard', 'profile');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 1);
  gate.resolve();
  const [one, two] = await Promise.all([a, b]);
  assert.deepEqual(one, two);
  assert.equal(one.profile.itemLevel, 1740.83);
  assert.equal(one.profile.combatPower, 5123.45);
  assert.equal(one.profile.characterImage, characterImage);
  assert.equal(JSON.stringify(one).includes('synthetic'), false);
  f.control.hook = null;
  await f.service.get('TESTBARD', 'profile');
  assert.equal(f.calls.length, 1);
  f.advance(300001);
  await f.service.get('testbard', 'profile');
  assert.equal(f.calls.length, 2);
});

test('details uses one filtered armory request and never invents absent crit values', async t => {
  const f = fixture(t);
  const result = await f.service.get(name, 'details');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].searchParams.get('filters'), 'profiles+avatars+equipment+engravings+gems+arkpassive+combat-skills+cards+arkgrid');
  assert.equal(result.crit, null);
  assert.equal(result.combatStats, null);
  assert.deepEqual(result.equipment, []);
});

test('combat stats allow known numeric values and preserve real zero without manufacturing missing stats', () => {
  assert.deepEqual(normalizeCombatStats([
    { Type: '치명', Value: '612' }, { Type: '특화', Value: 1842 },
    { Type: '최대 생명력', Value: '3,245,672' }, { Type: '신속', Value: '0' },
    { Type: '공격력', Value: '128,430.5' }, { Type: '내부 값', Value: 999 },
  ]), [
    { name: '공격력', value: 128430.5 }, { name: '최대 생명력', value: 3245672 },
    { name: '치명', value: 612 }, { name: '특화', value: 1842 }, { name: '신속', value: 0 },
  ]);
  for (const value of [null, {}, [], new Array(21).fill({ Type: '치명', Value: '1' }),
    [{ Type: '치명', Value: '1' }, { Type: '치명', Value: '2' }]]) assert.equal(normalizeCombatStats(value), null);
  for (const value of ['', ' ', '1,00', '1e3', '-1', 'NaN', NaN, Infinity, -1, true, {}, [],
    '9007199254740992', '0'.repeat(33), '<b>12</b>']) {
    assert.equal(normalizeCombatStats([{ Type: '치명', Value: value }]), null, String(value));
  }
});

test('details adds combat stats from the existing request without changing crit or cache behavior', async t => {
  const f = fixture(t);
  f.control.armory = { ArmoryProfile: { ...profile(), Stats: [{ Type: '치명', Value: '612', Tooltip: ['private tooltip'] }] },
    ArmoryEquipment: [], ArmoryGem: { Gems: [], Effects: null }, ArmoryEngraving: { ArkPassiveEffects: [] },
    ArkPassive: { IsArkPassive: false, Points: [], Effects: [] } };
  const result = await f.service.get(name, 'details');
  assert.deepEqual(result.combatStats, [{ name: '치명', value: 612 }]);
  assert.equal(result.crit, null);
  assert.equal(JSON.stringify(result).includes('private tooltip'), false);
  assert.deepEqual(await f.service.get(name, 'details'), result);
  assert.equal(f.calls.length, 1);
});

test('cards are included in the same armory request and cached without changing equipment or crit fields', async t => {
  const f = fixture(t);
  f.control.armory = { ArmoryProfile: profile(), ArmoryEquipment: [], ArmoryGem: { Gems: [], Effects: null },
    ArmoryEngraving: { ArkPassiveEffects: [] }, ArkPassive: { IsArkPassive: false, Points: [], Effects: [] },
    ArmoryCard: { Cards: [{ Slot: 0, Name: '니나브', Grade: '전설', AwakeCount: 5, AwakeTotal: 5 }],
      Effects: [{ Index: 0, CardSlots: [0], Items: [{ Name: '활성 세트 효과', Description: '성속성 피해 +8%' }] }] } };
  const result = await f.service.get(name, 'details');
  assert.equal(result.cards.items[0].name, '니나브');
  assert.equal(result.cards.items[0].awakeCount, 5);
  assert.equal(result.cards.sets[0].items[0].effects[0].text, '성속성 피해 +8%');
  assert.deepEqual(result.equipment, []); assert.equal(result.crit, null);
  assert.ok(f.calls[0].searchParams.get('filters').split('+').includes('cards'));
  assert.deepEqual(await f.service.get(name, 'details'), result);
  assert.equal(f.calls.length, 1);
});

test('roster includes every server; arkgrid reuses siblings and only fetches the anchor server', async t => {
  const f = fixture(t);
  const list = await f.service.get(name, 'roster');
  assert.equal(list.roster.characters.length, 3);
  const grid = await f.service.get(name, 'arkgrid');
  assert.equal(f.calls.filter(url => url.pathname.endsWith('/siblings')).length, 1);
  assert.equal(f.calls.filter(url => url.pathname.endsWith('/arkgrid')).length, 2);
  assert.equal(grid.arkgrid.partial, false);
  assert.equal(grid.arkgrid.totals.cores.고대, 1);
  assert.equal(grid.arkgrid.totals.points, 20);
  assert.deepEqual(grid.arkgrid.characters.map(row => row.name), [name]);
  assert.ok(f.calls.every(url => !url.pathname.includes(encodeURIComponent('다른서버'))));
});

test('a gear-less character (item level 0.00) stays in the roster and is skipped by the roster grid', async t => {
  const f = fixture(t);
  f.control.zeroLevel = true;
  const list = await f.service.get(name, 'roster');
  assert.deepEqual(list.roster.characters.map(row => [row.characterName, row.itemLevel]).slice(-1), [['장비없는캐릭터', 0]]);
  assert.equal(list.roster.characters.length, 4);
  const grid = await f.service.get(name, 'arkgrid');
  assert.equal(grid.arkgrid.partial, false);
  assert.ok(f.calls.every(url => !url.pathname.includes(encodeURIComponent('장비없는캐릭터'))));
});

test('character grid uses the existing combined request and is independent of the legacy roster-grid section', async t => {
  const f = fixture(t);
  f.control.armory = { ArmoryProfile: profile(), ArmoryEquipment: [], ArmoryGem: { Gems: [] },
    ArmoryEngraving: { ArkPassiveEffects: [] }, ArkPassive: { IsArkPassive: false },
    ArkGrid: { Slots: [{ Index: 0, Name: '질서의 해 코어', Grade: '유물', Point: 18,
      Gems: [{ Index: 0, Grade: '전설', IsActive: false }] }], Effects: [{ Name: '공격력', Level: 12, Tooltip: '공격력 +1%' }] },
  };
  const [result, shared] = await Promise.all([f.service.get(name, 'details'), f.service.get(name, 'details')]);
  assert.deepEqual(result, shared);
  assert.equal(result.arkgrid.cores[0].name, '질서의 해 코어');
  assert.equal(result.arkgrid.cores[0].points, 18);
  assert.equal(result.arkgrid.cores[0].gems[0].isActive, false);
  assert.equal(result.arkgrid.effects[0].level, 12);
  assert.deepEqual(result.equipment, []); assert.equal(result.crit, null);
  assert.deepEqual(await f.service.get(name, 'details'), result);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].searchParams.get('filters').split('+').filter(value => value === 'arkgrid').length, 1);
  const rosterGrid = await f.service.get(name, 'arkgrid');
  assert.equal(rosterGrid.arkgrid.totals.points, 20);
  assert.equal(Object.hasOwn(rosterGrid.arkgrid, 'cores'), false);
  assert.equal(f.calls.filter(url => url.pathname.endsWith('/arkgrid')).length, 2);
  assert.deepEqual(await f.service.get(name, 'details'), result);
});

test('upstream errors are mapped and failures are not cached', async t => {
  const f = fixture(t);
  for (const [mode, status, code] of [
    ['null', 404, 'character_not_found'], ['http404', 404, 'character_not_found'],
    ['http500', 502, 'character_unavailable'], ['html', 502, 'character_unavailable'],
    ['invalid', 502, 'character_unavailable'], ['oversize', 502, 'character_unavailable'],
  ]) {
    f.control.mode = mode;
    await assert.rejects(f.service.get(name, 'details'), isError(status, code));
  }
  f.control.mode = 'normal';
  assert.ok(await f.service.get(name, 'details'));
  assert.equal(f.calls.length, 7);
});

test('invalid calculation inputs affect only crit and never become a cached zero or partial total', async t => {
  const f = fixture(t);
  const raw = { ArmoryProfile: { ...profile(), Stats: [{ Type: '치명', Value: '100', Tooltip: ['치명타 적중률이 <font>3.50%</font> 증가합니다.'] }] },
    ArmoryEquipment: [], ArmorySkills: [], ArmoryEngraving: { ArkPassiveEffects: [] },
    ArkPassive: { IsArkPassive: true, Effects: [] }, ArmoryGem: { Gems: [] } };
  f.control.armory = raw;
  assert.equal((await f.service.get(name, 'details')).crit.total, 3.5);
  for (const mutate of [
    value => { value.ArmoryEquipment = [null]; },
    value => { value.ArkPassive.Effects = {}; },
    value => { value.ArmoryProfile.Stats[0].Tooltip = ['schema changed']; },
    value => { value.ArmoryProfile.Stats[0].Tooltip = ['치명타 적중률이 <font>1..2%</font> 증가합니다.']; },
    value => { delete value.ArmoryEngraving; },
    value => { value.ArmoryEquipment = [{ Type: '반지', Name: '반지', Tooltip: 'null' }]; },
  ]) {
    f.advance(300001);
    f.control.armory = structuredClone(raw);
    mutate(f.control.armory);
    const result = await f.service.get(name, 'details');
    assert.equal(result.crit, null);
    assert.ok(Object.hasOwn(result, 'equipment'));
    assert.ok(Object.hasOwn(result, 'gems'));
  }
});

test('429 pauses new upstream work while cached successful profiles remain available', async t => {
  const f = fixture(t);
  await f.service.get(name, 'profile');
  f.control.mode = 'http429';
  await assert.rejects(f.service.get('다른바드', 'profile'), isError(429, 'character_rate_limited'));
  f.control.mode = 'normal';
  await assert.rejects(f.service.get('새로운바드', 'profile'), isError(429, 'character_rate_limited'));
  await f.service.get(name, 'profile');
  assert.equal(f.calls.length, 2);
  f.advance(60001);
  await f.service.get('새로운바드', 'profile');
  assert.equal(f.calls.length, 3);
});

test('web sliding quota and upstream remaining header preserve headroom for the bot', async t => {
  const f = fixture(t, { upstreamPerMinute: 2 });
  await f.service.get(name, 'profile');
  await f.service.get('다른바드', 'profile');
  await assert.rejects(f.service.get('세번째바드', 'profile'), isError(429, 'character_rate_limited'));
  assert.equal(f.calls.length, 2);
  f.advance(60001);
  f.control.headers = { 'X-RateLimit-Remaining': '10', 'X-RateLimit-Reset': String(Math.floor(f.now() / 1000) + 60) };
  await f.service.get('세번째바드', 'profile');
  await assert.rejects(f.service.get('네번째바드', 'profile'), isError(429, 'character_rate_limited'));
  assert.equal(f.calls.length, 3);
});

test('partial grid failures are retryable and malformed grids do not poison the success cache', async t => {
  const f = fixture(t);
  f.control.mode = 'bad-grid';
  const partial = await f.service.get(name, 'arkgrid');
  assert.equal(partial.arkgrid.partial, true);
  f.control.mode = 'normal';
  const complete = await f.service.get(name, 'arkgrid');
  assert.equal(complete.arkgrid.partial, false);
  assert.equal(complete.arkgrid.totals.points, 20);
});

test('upstream concurrency, timeout, and close release pending work without leaking secrets', async t => {
  const f = fixture(t, { concurrency: 2, requestTimeoutMs: 40 });
  let peak = 0;
  let active = 0;
  f.control.hook = signal => new Promise((resolve, reject) => {
    active++; peak = Math.max(peak, active);
    signal.addEventListener('abort', () => { active--; reject(new Error('private timeout detail')); }, { once: true });
  });
  const results = await Promise.allSettled(['첫째바드', '둘째바드', '셋째바드'].map(value => f.service.get(value, 'details')));
  assert.equal(peak, 2);
  for (const result of results) assert.ok(result.status === 'rejected' && result.reason.code === 'character_unavailable');
  const waiting = f.service.get('넷째바드', 'details');
  await new Promise(resolve => setImmediate(resolve));
  f.service.close();
  await assert.rejects(waiting, isError(502, 'character_unavailable'));
});

test('cache entry and public IP budgets stay bounded and reset on time', async t => {
  const f = fixture(t, { maxEntries: 1 });
  await f.service.get(name, 'profile');
  await f.service.get('다른바드', 'profile');
  await f.service.get(name, 'profile');
  assert.equal(f.calls.length, 3);
  for (let i = 0; i < 60; i++) assert.equal(f.service.allow('192.0.2.1'), true);
  assert.equal(f.service.allow('192.0.2.1'), false);
  assert.equal(f.service.allow('192.0.2.2'), true);
  f.advance(60001);
  assert.equal(f.service.allow('192.0.2.1'), true);
});

test('approved HTTP route has no-store, strict input, origin guards, method checks, and sanitized errors', async t => {
  const f = fixture(t);
  const directory = await mkdtemp(join(tmpdir(), 'web-spec-'));
  const app = createWebServer({ config: { ...config, origin: 'https://opentalk.example.invalid', host: '127.0.0.1', port: 0,
    dbPath: join(directory, 'auth.sqlite'), providers: {} }, fetchImpl: f.fetchImpl, now: f.now });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const request = approvedRequester(join(directory, 'auth.sqlite'), f.now());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const path = `/api/character/spec?name=${encodeURIComponent(name)}&section=profile`;
  assert.equal((await fetch(base + path)).status, 200, 'character lookup is public');
  const response = await request(base + path);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal((await response.json()).profile.characterName, name);
  for (const suffix of ['&name=다른바드', '&extra=1', '&section=details']) assert.equal((await request(base + path + suffix)).status, 400);
  assert.equal((await request(base + '/api/character/spec?name=x&section=profile')).status, 400);
  assert.equal((await request(base + path, { method: 'POST' })).status, 405);
  assert.equal((await request(base + path, { headers: { Origin: 'https://untrusted.invalid' } })).status, 403);
  assert.equal((await request(base + path, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  f.control.mode = 'http429';
  const denied = await request(base + path.replace('section=profile', 'section=details'));
  assert.equal(denied.status, 429);
  assert.equal(denied.headers.get('retry-after'), '60');
  assert.deepEqual(await denied.json(), { error: 'character_rate_limited' });
});

test('extended profiles allow only bounded official armory portrait URLs', async () => {
  const images = [characterImage, 'https://cdn-lostark.game.onstove.com/armory/portrait.png',
    'https://cdn-lostark.game.onstove.com/armory/4/portrait_2.webp?v=version-2'];
  for (const CharacterImage of images) {
    const result = await findCharacterProfile(config, name, async () => Response.json({ ...profile(), CharacterImage }), { extended: true });
    assert.equal(result.characterImage, CharacterImage);
  }
  for (const CharacterImage of [undefined, null, 1, {}, '',
    'http://cdn-lostark.game.onstove.com/armory/a.jpg', 'javascript:alert(1)',
    'https://cdn-lostark.game.onstove.com.evil.example/armory/a.jpg',
    'https://user:maintainer@example.com/armory/a.jpg',
    'https://cdn-lostark.game.onstove.com:443/armory/a.jpg',
    'https://cdn-lostark.game.onstove.com/efui_iconatlas/a.jpg',
    'https://cdn-lostark.game.onstove.com/armory/../private/a.jpg',
    'https://cdn-lostark.game.onstove.com/armory/%2e%2e/a.jpg',
    'https://cdn-lostark.game.onstove.com/armory/a.svg',
    'https://cdn-lostark.game.onstove.com/armory/a.jpg?v=1&redirect=https://evil.example',
    'https://cdn-lostark.game.onstove.com/armory/a.jpg?other=1',
    'https://cdn-lostark.game.onstove.com/armory/a.jpg?v=' + '1'.repeat(65),
    'https://cdn-lostark.game.onstove.com/armory/a.jpg#fragment',
    characterImage + '\n', 'https://cdn-lostark.game.onstove.com/armory/' + 'a'.repeat(2048) + '.jpg']) {
    const result = await findCharacterProfile(config, name, async () => Response.json({ ...profile(), CharacterImage }), { extended: true });
    assert.equal(result.characterImage, null, typeof CharacterImage === 'string' ? CharacterImage.slice(0, 100) : 'non-string');
    assert.equal(result.characterName, name);
  }
});

test('signup profile contract remains exactly four fields even with a valid official portrait', async () => {
  const response = () => Response.json(profile());
  const expected = { characterName: name, serverName: '루페온', characterClass: '바드', itemLevel: 1740.83 };
  assert.deepEqual(await findCharacterProfile(config, name, response), expected);
  assert.deepEqual(await findCharacterProfile(config, name, response, { extended: false }), expected);
});
