import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemberRosterService } from '../src/member-roster.js';
import { GuildError } from '../src/guild-store.js';

const timestamp = Date.parse('2026-09-16T00:00:00Z');
const config = { automaticApproval: { lostArkApiKey: 'synthetic-roster-key' } };
const anchorName = '인증캐릭터';
const profile = (CharacterName = anchorName, overrides = {}) => ({ CharacterName, ServerName: '루페온', CharacterClassName: '바드', ItemAvgLevel: '1,740.83', ...overrides });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, options = {}) {
  const calls = []; let currentTime = timestamp;
  const service = createMemberRosterService({ config, now: () => currentTime,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const name = decodeURIComponent(new URL(url).pathname.split('/')[2]);
      return Response.json([profile(name)]);
    }, ...options });
  t.after(() => service.close());
  return { service, calls, advance: ms => { currentTime += ms; } };
}

test('one official siblings request returns normalized rows and ordered server groups without extra private fields', async t => {
  const source = [profile('가나다', { ServerName: '카제로스', ItemAvgLevel: '1,800.00' }),
    profile(anchorName, { ServerName: ' 루페온 ', CharacterClassName: ' 바드 ', extra: 'private', ItemAvgLevel: '1,740.83' }),
    profile('동생캐릭터', { ItemAvgLevel: '1,600.00' }), profile('라바마', { ServerName: '아만', ItemAvgLevel: '1,800' }),
    profile('나나다', { ServerName: '카제로스', ItemAvgLevel: '1,800.00' })];
  let calls = 0; const before = JSON.stringify(source);
  const f = fixture(t, { fetchImpl: async (url, init) => {
    calls++; assert.equal(url, `https://developer-lostark.game.onstove.com/characters/${encodeURIComponent(anchorName)}/siblings`);
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error'); assert.equal(init.headers.Authorization, 'bearer synthetic-roster-key');
    return Response.json(source);
  } });
  const result = await f.service.get(` ${anchorName.normalize('NFD')} `);
  assert.equal(calls, 1); assert.equal(result.updatedAt, timestamp);
  assert.deepEqual(result.anchor, { characterName: anchorName, serverName: '루페온', characterClass: '바드', itemLevel: 1740.83 });
  assert.deepEqual(result.groups.map(row => row.serverName), ['루페온', '아만', '카제로스']);
  assert.deepEqual(result.groups[0].characters.map(row => row.characterName), [anchorName, '동생캐릭터']);
  assert.deepEqual(result.groups[2].characters.map(row => row.characterName), ['가나다', '나나다']);
  assert.equal(result.characters[0].itemLevel, 1800); assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(JSON.stringify(result).includes('synthetic-roster-key'), false); assert.equal(JSON.stringify(source), before);
});

test('normal requests share NFC/case-insensitive pending work and a five-minute cache without mutation leaks', async t => {
  const gate = deferred(); let calls = 0;
  const f = fixture(t, { fetchImpl: async () => { calls++; await gate.promise; return Response.json([profile('TestBard')]); } });
  const a = f.service.get(' TestBard '), b = f.service.get('testbard'); await tick(); assert.equal(calls, 1); gate.resolve();
  const [first, second] = await Promise.all([a, b]);
  first.anchor.characterName = '변조캐릭터'; first.characters.length = 0; first.groups[0].characters[0].itemLevel = 9999;
  assert.equal(second.anchor.characterName, 'TestBard'); assert.equal(second.characters[0].itemLevel, 1740.83);
  assert.equal((await f.service.get('TESTBARD')).characters[0].itemLevel, 1740.83); assert.equal(calls, 1);
  f.advance(300001); await f.service.get('TestBard'); assert.equal(calls, 2);
});

test('fresh selection bypasses cached and pending lists; an older response cannot replace the newer cache', async t => {
  const old = deferred(); let calls = 0;
  const f = fixture(t, { fetchImpl: async () => {
    calls++; if (calls === 1) return old.promise;
    return Response.json([profile(), profile('새대표캐릭터')]);
  } });
  const first = f.service.get(anchorName); await tick();
  const selected = await f.service.verifySelection(anchorName, '새대표캐릭터');
  assert.equal(calls, 2); assert.equal(selected.character.characterName, '새대표캐릭터'); assert.equal(selected.anchor.characterName, anchorName); assert.equal(selected.verifiedAt, timestamp);
  old.resolve(Response.json([profile(), profile('이전캐릭터')]));
  assert.equal((await first).characters.some(row => row.characterName === '이전캐릭터'), true);
  assert.equal((await f.service.get(anchorName)).characters.some(row => row.characterName === '새대표캐릭터'), true); assert.equal(calls, 2);
  await f.service.verifySelection(anchorName, '새대표캐릭터'); assert.equal(calls, 3);
});

test('newer failed validation invalidates old cache and an older completion cannot restore it', async t => {
  const old = deferred(); let calls = 0;
  const f = fixture(t, { fetchImpl: async () => {
    calls++; if (calls === 1) return old.promise;
    if (calls === 2) return Response.json([profile('다른계정')]);
    return Response.json([profile(), profile('새대표캐릭터')]);
  } });
  const first = f.service.get(anchorName); await tick();
  await assert.rejects(f.service.get(anchorName, { fresh: true }), { status: 502, code: 'member_roster_unavailable' });
  old.resolve(Response.json([profile()])); await first;
  assert.equal((await f.service.get(anchorName)).characters.length, 2); assert.equal(calls, 3);
});

test('selection uses canonical official membership and rejects unlisted or invalid characters', async t => {
  let rows = [profile(), profile('TestBard')], calls = 0;
  const f = fixture(t, { fetchImpl: async () => { calls++; return Response.json(rows); } });
  await f.service.get(anchorName);
  assert.equal((await f.service.verifySelection(anchorName, ' testbard ')).character.characterName, 'TestBard');
  rows = [profile()]; await assert.rejects(f.service.verifySelection(anchorName, 'TestBard'), { status: 400, code: 'member_roster_selection_invalid' });
  assert.equal(calls, 3);
  await assert.rejects(f.service.verifySelection(anchorName, '../invalid'), { status: 400 }); assert.equal(calls, 3);
});

test('null or empty accounts are404; absent anchors, duplicate names and malformed profile fields are502', async t => {
  for (const rows of [null, []]) {
    const f = fixture(t, { fetchImpl: async () => Response.json(rows) });
    await assert.rejects(f.service.get(anchorName), { status: 404, code: 'member_roster_not_found' });
  }
  for (const rows of [{}, [profile('다른계정')], [profile(), profile(anchorName.normalize('NFD'))],
    [profile(), profile('CaseName'), profile('casename')], [profile(anchorName, { ItemAvgLevel: '1,,740' })],
    [profile(anchorName, { ItemAvgLevel: 1740 })], [profile(anchorName, { ItemAvgLevel: '10000.01' })],
    [profile(anchorName, { ServerName: '<img>' })], [profile(anchorName, { ServerName: '루페온\u202e' })],
    [profile(anchorName, { CharacterClassName: '\ud800' })], [profile(anchorName, { CharacterClassName: '  ' })],
    [null], [profile(anchorName, { CharacterName: 'x' })]]) {
    const f = fixture(t, { fetchImpl: async () => Response.json(rows) });
    await assert.rejects(f.service.get(anchorName), { status: 502, code: 'member_roster_unavailable' });
  }
});

test('512 valid character rows are supported and513 is rejected', async t => {
  let count = 512;
  const f = fixture(t, { cacheMs: 0, fetchImpl: async () => Response.json([profile(), ...Array.from({ length: count - 1 }, (_, i) => profile(`부캐${i}`))]) });
  assert.equal((await f.service.get(anchorName)).characters.length, 512);
  count = 513; await assert.rejects(f.service.get(anchorName), { status: 502 });
});

test('upstream status and shared-budget errors are sanitized and no failed result is cached', async t => {
  for (const [status, expected, code] of [[404, 404, 'member_roster_not_found'], [429, 429, 'member_roster_rate_limited'],
    [401, 502, 'member_roster_unavailable'], [500, 502, 'member_roster_unavailable'], [503, 502, 'member_roster_unavailable']]) {
    let calls = 0;
    const f = fixture(t, { fetchImpl: async () => { calls++; return calls === 1 ? Response.json({ secret: 'private-error' }, { status }) : Response.json([profile()]); } });
    await assert.rejects(f.service.get(anchorName), error => error.status === expected && error.code === code && !String(error).includes('private-error'));
    f.advance(60001); await f.service.get(anchorName); assert.equal(calls, 2);
  }
  const f = fixture(t, { fetchImpl: async () => { throw new GuildError(429, 'character_rate_limited'); } });
  await assert.rejects(f.service.get(anchorName), { status: 429, code: 'member_roster_rate_limited' });
});

test('media type, redirected responses, malformed JSON and512KiB bodies are rejected', async t => {
  for (const response of [() => new Response('<html>'), () => new Response('{', { headers: { 'Content-Type': 'application/json' } }),
    () => new Response('[]', { headers: { 'Content-Type': 'application/json', 'Content-Length': String(512 * 1024 + 1) } }),
    () => new Response(' '.repeat(512 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } }),
    () => new Response(new Uint8Array([0xff, 0xfe]), { headers: { 'Content-Type': 'application/json' } }),
    () => { const value = Response.json([profile()]); Object.defineProperty(value, 'redirected', { value: true }); return value; }]) {
    const f = fixture(t, { fetchImpl: async () => response() });
    await assert.rejects(f.service.get(anchorName), { status: 502, code: 'member_roster_unavailable' });
  }
});

test('input, configuration and closed states fail before networking', async t => {
  const f = fixture(t);
  for (const name of [null, '', 'x', 'bad/name', '시험<script>']) await assert.rejects(f.service.get(name), { status: 400 });
  await assert.rejects(f.service.get(anchorName, { fresh: 'true' }), { status: 400 }); assert.equal(f.calls.length, 0);
  const unavailable = fixture(t, { config: {} });
  await assert.rejects(unavailable.service.get(anchorName), { status: 503, code: 'member_roster_unavailable' }); assert.equal(unavailable.calls.length, 0);
  f.service.close(); f.service.close(); assert.equal(f.service.allow('ip'), false);
  await assert.rejects(f.service.get(anchorName), { status: 503 }); assert.equal(f.calls.length, 0);
});

test('local request limits, observed remaining reserve and IP allowance are bounded', async t => {
  const f = fixture(t, { upstreamPerMinute: 2 });
  await f.service.get(anchorName); await f.service.get(anchorName, { fresh: true });
  await assert.rejects(f.service.get(anchorName, { fresh: true }), { status: 429 }); assert.equal(f.calls.length, 2);
  for (let i = 0; i < 30; i++) assert.equal(f.service.allow('ip'), true); assert.equal(f.service.allow('ip'), false);
  f.advance(60001); assert.equal(f.service.allow('ip'), true); await f.service.get(anchorName, { fresh: true }); assert.equal(f.calls.length, 3);
  let calls = 0;
  const reserve = fixture(t, { fetchImpl: async () => { calls++; return Response.json([profile()], { headers: { 'x-ratelimit-remaining': '15', 'x-ratelimit-reset': String(timestamp / 1000 + 60) } }); } });
  await reserve.service.get(anchorName); await assert.rejects(reserve.service.get(anchorName, { fresh: true }), { status: 429 }); assert.equal(calls, 1);
});

test('LRU entry and serialized-byte budgets evict cached responses without affecting returned data', async t => {
  const f = fixture(t, { maxEntries: 2 });
  await f.service.get('캐릭터1'); await f.service.get('캐릭터2'); await f.service.get('캐릭터1'); await f.service.get('캐릭터3');
  await f.service.get('캐릭터1'); assert.equal(f.calls.length, 3); await f.service.get('캐릭터2'); assert.equal(f.calls.length, 4);
  const bytes = fixture(t, { maxCacheBytes: 1 });
  assert.equal((await bytes.service.get(anchorName)).characters.length, 1); await bytes.service.get(anchorName); assert.equal(bytes.calls.length, 2);
});

test('two physical requests and eight queued operations bound admission; close aborts all waiters', async t => {
  const gates = [], signals = [];
  const f = fixture(t, { fetchImpl: async (_url, init) => { signals.push(init.signal); const gate = deferred(); gates.push(gate); return gate.promise; } });
  const jobs = Array.from({ length: 10 }, (_, i) => f.service.get(`캐릭터${i}`).catch(error => error)); await tick(); assert.equal(gates.length, 2);
  await assert.rejects(f.service.get('추가캐릭터'), { status: 429 }); f.service.close();
  const results = await Promise.all(jobs); assert.ok(results.every(error => error.status === 503)); assert.ok(signals.every(signal => signal.aborted));
  for (const gate of gates) gate.resolve(Response.json([profile()])); await tick();
});

test('noncooperative transport expiry holds actual slots and late results do not enter cache', async t => {
  const gates = []; let calls = 0;
  const f = fixture(t, { requestTimeoutMs: 20, fetchImpl: async url => {
    calls++; const name = decodeURIComponent(new URL(url).pathname.split('/')[2]);
    if (calls > 2) return Response.json([profile(name)]);
    const gate = deferred(); gates.push({ gate, name }); return gate.promise;
  } });
  await Promise.all([assert.rejects(f.service.get('캐릭터1'), { status: 502 }), assert.rejects(f.service.get('캐릭터2'), { status: 502 })]);
  await assert.rejects(f.service.get('캐릭터3'), { status: 502 }); assert.equal(calls, 2);
  for (const { gate, name } of gates) gate.resolve(Response.json([profile(name)])); await tick();
  assert.equal((await f.service.get('캐릭터1')).anchor.characterName, '캐릭터1'); assert.equal(calls, 3);
});

test('the deadline also covers a response body that ignores abort', async t => {
  let streamController;
  const f = fixture(t, { requestTimeoutMs: 20, fetchImpl: async () => new Response(new ReadableStream({ start(controller) { streamController = controller; } }),
    { headers: { 'Content-Type': 'application/json' } }) });
  await assert.rejects(f.service.get(anchorName), { status: 502 });
  streamController.enqueue(new TextEncoder().encode(JSON.stringify([profile()]))); streamController.close(); await tick();
});

test('a gear-less character with item level 0.00 is listed instead of failing the whole roster', async t => {
  const source = [profile(anchorName), profile('만들기만한캐릭터', { CharacterClassName: '전사(여)', ItemAvgLevel: '0.00' })];
  const f = fixture(t, { fetchImpl: async () => Response.json(source) });
  const result = await f.service.get(anchorName);
  assert.deepEqual(result.groups[0].characters.map(row => [row.characterName, row.itemLevel]), [[anchorName, 1740.83], ['만들기만한캐릭터', 0]]);
});
