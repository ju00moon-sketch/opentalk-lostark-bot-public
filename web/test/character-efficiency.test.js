import { approvedRequester } from './helpers/access.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createWebServer } from '../src/server.js';
import { createCharacterEfficiencyService } from '../src/character-efficiency.js';
import { createCharacterEfficiencyServer } from '../../src/character-efficiency-server.js';
import { efficiencyConnection, normalizeEfficiencyName, normalizeEfficiencyResult } from '../../src/character-efficiency-contract.js';
import { normalizeCharacter } from '../src/character-profile.js';
import { CUTS_VERSION } from '../../src/score-tier.js';
import { classifyNativeSpecTier } from '../../src/native-spec-score.js';

const token = 'x'.repeat(43);
const config = { url: 'http://127.0.0.1:52999', token };
const result = (name = '테스트캐릭터', time = Date.now()) => ({ characterName: name, source: 'lopec', calculatedAt: time,
  bracelet: { status: 'ok', efficiency: 15.62 }, gem: { status: 'ok', efficiency: 9.41, optionEfficiency: 2.2, pointEfficiency: 7.05,
    effectEfficiencies: [{ name: '추가 피해', level: 5, effect: 2.5, efficiency: 0 }] } });
const empty = name => ({ ...result(name), bracelet: { status: 'unavailable', efficiency: null },
  gem: { status: 'unsupported', efficiency: null, optionEfficiency: null, pointEfficiency: null, effectEfficiencies: [] } });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('connection requires a canonical loopback endpoint and an independent token', () => {
  assert.equal(efficiencyConnection().enabled, false);
  assert.equal(efficiencyConnection(config).enabled, true);
  for (const url of ['https://127.0.0.1:8092', 'http://localhost:8092', 'http://127.1:8092', 'http://127.0.0.1:80', 'http://127.0.0.1:8092/', 'http://127.0.0.1:8092/private', 'http://user@127.0.0.1:8092', 'http://127.0.0.1:8092?key=x']) {
    assert.throws(() => efficiencyConnection({ url, token }), /Invalid/);
  }
  for (const value of ['', 'short', 'x'.repeat(129), 'a '.repeat(30)]) assert.throws(() => efficiencyConnection({ ...config, token: value }));
  for (const name of ['테스트캐릭터', '  가나다  ', '가나다'.normalize('NFD'), 'Jackmus', '1가', '', '가', '../aa', 'a b', 'a'.repeat(13)]) assert.equal(normalizeEfficiencyName(name), normalizeCharacter(name));
});

test('public result keeps zero and every gem effect but removes unknown data', () => {
  const source = { ...result(), private: 'secret' };
  source.gem.extra = 'secret'; source.gem.effectEfficiencies[0].private = 'secret';
  const clean = normalizeEfficiencyResult(source, '테스트캐릭터');
  assert.equal(clean.gem.effectEfficiencies[0].efficiency, 0);
  assert.equal(JSON.stringify(clean).includes('secret'), false);
  assert.equal(normalizeEfficiencyResult(result('다른캐릭터'), '테스트캐릭터'), null);
  for (const mutate of [x => x.gem.efficiency = Infinity, x => x.bracelet.efficiency = '15.62', x => x.gem.effectEfficiencies[0].name = '<img>',
    x => x.gem.effectEfficiencies[0].level = -1, x => x.gem.effectEfficiencies = Array(33).fill(x.gem.effectEfficiencies[0]), x => x.gem.status = 'unsupported']) {
    const value = result(); mutate(value); assert.equal(normalizeEfficiencyResult(value, '테스트캐릭터'), null);
  }
  assert.equal(normalizeEfficiencyResult(empty('테스트캐릭터'), '테스트캐릭터').gem.status, 'unsupported');
});

test('companion authenticates before work and shares/cache-bounds a character pair', async t => {
  let calls = 0, current = 1000;
  const service = createCharacterEfficiencyServer({ config, now: () => current, cacheMs: 100, maxEntries: 2,
    calculateImpl: async name => { calls++; await delay(10); return result(name, current); } });
  service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening'); t.after(() => service.close());
  const base = `http://127.0.0.1:${service.server.address().port}/internal/character-efficiency`;
  assert.equal((await fetch(base + '?name=가나다')).status, 403); assert.equal(calls, 0);
  const headers = { Authorization: `Bearer ${token}` };
  for (const suffix of ['?name=가', '?name=가나다&name=라마바', '?name=가나다&extra=1', '?name=../name']) assert.equal((await fetch(base + suffix, { headers })).status, 400);
  assert.equal((await fetch(base + '?name=가나다', { headers, method: 'POST' })).status, 405);
  assert.equal((await fetch(base + '?name=가나다', { headers, method: 'GET' })).status, 200);
  const [a, b] = await Promise.all([service.get('라마바'), service.get('라마바')]);
  assert.deepEqual(a, b); assert.equal(calls, 2);
  await service.get('사아자'); await service.get('가나다'); assert.equal(calls, 4);
  current += 101; await service.get('가나다'); assert.equal(calls, 5);
});

test('companion bounds admission and keeps running work charged until it ends', async t => {
  const release = [];
  const service = createCharacterEfficiencyServer({ config, maxWaiting: 1, deadlineMs: 80, calculateImpl: name => new Promise(resolve => release.push(() => resolve(result(name)))) });
  t.after(() => service.close());
  const one = service.get('가나다'); await delay(1);
  const two = service.get('라마바'); const rejectedTwo = assert.rejects(two, { code: 'efficiency_unavailable' });
  await assert.rejects(service.get('사아자'), { status: 429 });
  await delay(100); await rejectedTwo;
  assert.equal(release.length, 1);
  release.shift()(); await assert.rejects(one, { code: 'efficiency_unavailable' });
  const three = service.get('사아자'); await delay(1); release.shift()(); assert.equal((await three).characterName, '사아자');
});


const nativeResult = name => ({ ...result(name), source: 'official-api', modelVersion: 'native-v1' });
test('web adapter reuses details, bounds admission, and never needs companion configuration', async t => {
  let calls = 0, current = 1000;
  const service = createCharacterEfficiencyService({ now: () => current,
    readDetails: async name => { calls++; return { efficiency: nativeResult(name) }; } });
  t.after(() => service.close());
  assert.equal((await service.get(' 가나닥 ')).source, 'official-api');
  assert.equal(calls, 1);
  for (let i = 0; i < 20; i++) assert.equal(service.allow('127.0.0.1'), true);
  assert.equal(service.allow('127.0.0.1'), false);
  current += 60001; assert.equal(service.allow('127.0.0.1'), true);
  await assert.rejects(service.get('../a'), { status: 400 });
});

test('web adapter rejects foreign or legacy results and shutdown work', async () => {
  for (const value of [null, { efficiency: result('가나닥') }, { efficiency: nativeResult('다른사람') }]) {
    const service = createCharacterEfficiencyService({ readDetails: async () => value });
    await assert.rejects(service.get('가나닥'), { status: 502 });
    service.close();
  }
  let release;
  const service = createCharacterEfficiencyService({ readDetails: () => new Promise(resolve => { release = resolve; }) });
  const pending = service.get('가나닥');
  service.close(); release({ efficiency: nativeResult('가나닥') });
  await assert.rejects(pending, { status: 502 });
  await assert.rejects(service.get('가나닥'), { status: 503 });
});

test('approved HTTP shares details with efficiency and never calls external calculation or sends secrets', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'native-efficiency-web-'));
  const calls = [];
  let lopecCalls = 0;
  const app = createWebServer({ config: { origin: 'https://opentalk.example.invalid', host: '127.0.0.1', port: 0,
    dbPath: join(directory, 'state.sqlite'), providers: {}, automaticApproval: { lostArkApiKey: 'synthetic-game-key' } },
    readLopecScore: async () => { lopecCalls++; return { totalPercent: 6.92 }; },
    fetchImpl: async (url, init) => {
      calls.push(url); assert.equal(new URL(url).origin, 'https://developer-lostark.game.onstove.com');
      assert.equal(init.headers.Authorization, 'bearer synthetic-game-key');
      return Response.json({ ArmoryProfile: { CharacterName: '테스트캐릭터', CharacterClassName: '블레이드', ServerName: '루페온', ItemAvgLevel: '1,740.00' },
        ArmoryEquipment: [], ArmoryGem: { Gems: [], Effects: null }, ArmoryEngraving: { ArkPassiveEffects: [] },
        ArkPassive: { IsArkPassive: false, Points: [], Effects: [] }, ArkGrid: { Slots: [], Effects: [] } });
    } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const request = approvedRequester(join(directory, 'state.sqlite'));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const path = '/api/character/efficiency?name=테스트캐릭터';
  assert.equal((await fetch(`${base}/api/lounge`)).status, 401, 'member routes still need a session');
  assert.equal(calls.length, 0);
  const [response, detailsResponse] = await Promise.all([
    request(base + path), request(base + '/api/character/spec?name=테스트캐릭터&section=details')]);
  const body = await response.json(), details = await detailsResponse.json();
  assert.equal(response.status, 200); assert.equal(detailsResponse.status, 200);
  const { tier, scoreRecord, ...efficiency } = body;
  assert.equal(scoreRecord, null);
  assert.equal(body.source, 'official-api'); assert.deepEqual(efficiency, details.efficiency);
  // This fixture has no ark passive, so the score is unavailable and the lopec lookup is never attempted.
  assert.deepEqual(tier, { status: 'unavailable', key: null, name: null, rank: null, basis: 'fixed', percentile: null, population: null,
    source: '고정 점수 구간', sampledAt: null, next: null, reason: 'score_unavailable', reference: null, cutsVersion: CUTS_VERSION, art: null });
  assert.equal(lopecCalls, 0);
  // Besides the armory read, the custom tier art reads the anchor's roster once (six-hour cache), never per character.
  assert.deepEqual(calls.map(url => new URL(url).pathname), ['/armories/characters/%ED%85%8C%EC%8A%A4%ED%8A%B8%EC%BA%90%EB%A6%AD%ED%84%B0', '/characters/%ED%95%A9%EC%84%B1%EC%9B%90%EC%A0%95%EB%8C%80/siblings']);
  assert.equal((await request(base + path)).status, 200); assert.equal(calls.length, 2);
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('set-cookie'), null);
  assert(!JSON.stringify(body).includes('synthetic-game-key'));
  for (const suffix of ['?name=가', '?name=가나다&name=라마바', '?name=가나다&section=details']) assert.equal((await request(base + '/api/character/efficiency' + suffix)).status, 400);
  assert.equal((await request(base + path, { method: 'POST' })).status, 405);
  assert.equal((await request(base + path, { headers: { Origin: 'https://other.invalid' } })).status, 403);
  assert.equal((await request(base + path, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
});

test('tier follows the lopec percentile, shares one lookup, and falls back to the fixed cut', async () => {
  const score = { status: 'ok', score: 5115.78, role: 'dealer', tier: classifyNativeSpecTier(5115.78) };
  const stored = { efficiency: { ...nativeResult('가나닥'), score } };
  const withScore = () => stored;
  let current = 1000, lookups = 0;
  const lopec = createCharacterEfficiencyService({ readDetails: async name => withScore(name), now: () => current,
    readLopecScore: async () => { lookups++; await delay(5); return { totalPercent: 4.77, totalRank: 83057 }; } });
  const [a, b] = await Promise.all([lopec.get('가나닥'), lopec.get('가나닥')]);
  assert.equal(lookups, 1);
  assert.deepEqual(a.tier, b.tier);
  assert.deepEqual(a.tier, { status: 'ok', key: 'master', name: '마스터', rank: 7, basis: 'lopec', percentile: 4.77, population: null,
    source: '로펙 DB', sampledAt: new Date(1000).toISOString(), next: { key: 'grandmaster', name: '그랜드마스터', percentile: 1.5 }, reason: null, reference: null, cutsVersion: CUTS_VERSION, art: null });
  assert.deepEqual({ ...a, tier: undefined, scoreRecord: undefined }, { ...withScore('가나닥').efficiency, tier: undefined, scoreRecord: undefined });
  await lopec.get('가나닥'); assert.equal(lookups, 1);
  current += 5 * 60 * 1000; await lopec.get('가나닥'); assert.equal(lookups, 2);
  lopec.close();

  const fixed = { status: 'unavailable', key: 'diamond', name: '다이아몬드', rank: 6, basis: 'fixed', percentile: null, population: null,
    source: '고정 점수 구간', sampledAt: null, next: { key: 'master', name: '마스터', percentile: 5 }, reference: null, cutsVersion: CUTS_VERSION, art: null };
  const unknown = createCharacterEfficiencyService({ readDetails: async name => withScore(name), readLopecScore: async () => null });
  assert.deepEqual((await unknown.get('가나닥')).tier, { ...fixed, reason: 'lopec_unknown_character' }); unknown.close();
  const broken = createCharacterEfficiencyService({ readDetails: async name => withScore(name), readLopecScore: async () => { throw new Error('boom'); } });
  assert.deepEqual((await broken.get('가나닥')).tier, { ...fixed, reason: 'lopec_unavailable' }); broken.close();
  const odd = createCharacterEfficiencyService({ readDetails: async name => withScore(name), readLopecScore: async () => ({ totalPercent: '없음' }) });
  assert.deepEqual((await odd.get('가나닥')).tier, { ...fixed, reason: 'lopec_unavailable' }); odd.close();

  // The lopec page rounds to two decimals: a 0.00% beside a real rank is a top rank, a bare 0 is still no data.
  const top24 = createCharacterEfficiencyService({ readDetails: async name => withScore(name), readLopecScore: async () => ({ totalPercent: 0, totalRank: 24, dbScore: 5115.78 }) });
  const first = (await top24.get('가나닥')).tier; top24.close();
  assert.equal(first.status, 'ok'); assert.equal(first.key, 'esther'); assert.equal(first.percentile, 0.001); assert.equal(first.basis, 'lopec');
  const zero = createCharacterEfficiencyService({ readDetails: async name => withScore(name), readLopecScore: async () => ({ totalPercent: 0 }) });
  assert.deepEqual((await zero.get('가나닥')).tier, { ...fixed, reason: 'lopec_unavailable' }); zero.close();
  // A missing percentile beside an ordinary rank is still no data: Number(null) is 0, which once read as the top 0%
  // and awarded Esther (교차 검토 D-P2-1). A numeric string still counts.
  for (const missing of [null, '', false, undefined]) {
    const blank = createCharacterEfficiencyService({ readDetails: async name => withScore(name),
      readLopecScore: async () => ({ totalRank: 83057, totalPercent: missing, dbScore: 2000 }) });
    assert.deepEqual((await blank.get('가나닥')).tier, { ...fixed, reason: 'lopec_unavailable' }, String(missing)); blank.close();
  }
  const text = createCharacterEfficiencyService({ readDetails: async name => withScore(name), readLopecScore: async () => ({ totalPercent: '0.00', totalRank: '24' }) });
  const textTop = (await text.get('가나닥')).tier; text.close();
  assert.equal(textTop.key, 'esther'); assert.equal(textTop.percentile, 0.001);
  const tiny = createCharacterEfficiencyService({ readDetails: async name => withScore(name), readLopecScore: async () => ({ totalPercent: 0.001 }) });
  const top = (await tiny.get('가나닥')).tier;
  assert.equal(top.status, 'ok'); assert.equal(top.key, 'esther'); assert.equal(top.percentile, 0.001); assert.equal(top.next, null); tiny.close();

  const timers = [];
  const slow = createCharacterEfficiencyService({ readDetails: async name => withScore(name), tierTimeoutMs: 4000,
    readLopecScore: () => new Promise(() => {}), setTimer: fn => { timers.push(fn); return timers.length; }, clearTimer: () => {} });
  const pending = slow.get('가나닥');
  await delay(5); assert.equal(timers.length, 1); timers[0]();
  assert.deepEqual((await pending).tier, { ...fixed, reason: 'lopec_unavailable' }); slow.close();

  const noScore = createCharacterEfficiencyService({ readDetails: async name => ({ efficiency: { ...nativeResult(name), score: { status: 'unavailable', score: null, tier: null } } }),
    readLopecScore: async () => { throw new Error('must not be called'); } });
  assert.equal((await noScore.get('가나닥')).tier.reason, 'score_unavailable'); noScore.close();
});

test('the efficiency response carries the stored best score when a record store is attached', async () => {
  const score = { status: 'ok', score: 4238.59, role: 'dealer', tier: classifyNativeSpecTier(4238.59) };
  const stored = { efficiency: { ...nativeResult('가나닥'), score } };
  const records = { get: name => name === '가나닥' ? { characterName: '가나닥', score: 8428.219424347451, role: 'dealer', modelVersion: '2026-09-16.1', recordedAt: 1000 } : null };
  const service = createCharacterEfficiencyService({ readDetails: async () => stored, readLopecScore: async () => null, scoreRecords: records });
  assert.deepEqual((await service.get('가나닥')).scoreRecord, { score: 8428.22, role: 'dealer', modelVersion: '2026-09-16.1', recordedAt: 1000, current: false }); service.close();
  const same = createCharacterEfficiencyService({ readDetails: async () => stored, readLopecScore: async () => null, scoreRecords: { get: () => ({ characterName: '가나닥', score: 4238.59, role: 'dealer', modelVersion: 'm', recordedAt: 5 }) } });
  assert.equal((await same.get('가나닥')).scoreRecord.current, true); same.close();
  const broken = createCharacterEfficiencyService({ readDetails: async () => stored, readLopecScore: async () => null, scoreRecords: { get: () => { throw new Error('boom'); } } });
  assert.equal((await broken.get('가나닥')).scoreRecord, null); broken.close();
});

test('custom tier art marks the anchor and its roster, reads the roster once, and survives roster failures', async () => {
  const dream = { key: 'dream', name: '합성원정대', label: '합성원정대 전용 티어' };
  const score = { status: 'ok', score: 5115.78, role: 'dealer', tier: classifyNativeSpecTier(5115.78) };
  const stored = name => ({ efficiency: { ...nativeResult(name), score } });
  const lopec = async () => ({ totalPercent: 4.77, totalRank: 83057 });
  // (i) the anchor itself needs no roster read.
  const plain = createCharacterEfficiencyService({ readDetails: async name => stored(name), readLopecScore: lopec });
  assert.deepEqual((await plain.resolveTier('합성원정대', score)).art, dream);
  assert.equal((await plain.resolveTier('합성원정대', score)).key, 'master', 'the real tier is unchanged');
  assert.equal((await plain.resolveTier('가나닥', score)).art, null);
  assert.deepEqual((await plain.get('합성원정대')).tier.art, dream); plain.close();
  // (ii)+(iii) roster members share the artwork; one roster read serves every character for six hours.
  let current = 1000, rosterReads = [];
  const roster = async name => { rosterReads.push(name); await delay(5); return { roster: { characterName: '합성원정대', serverName: '루페온',
    characters: [{ characterName: '합성원정대' }, { characterName: '합성원정대둘' }, { characterName: 'DreamAlt' }] } }; };
  const service = createCharacterEfficiencyService({ readDetails: async name => stored(name), readLopecScore: lopec, readRoster: roster, now: () => current });
  const [alt, other, english, anchor] = await Promise.all([service.resolveTier('합성원정대둘', score), service.resolveTier('가나닥', score),
    service.resolveTier('dreamalt', score), service.resolveTier('합성원정대', score)]);
  assert.deepEqual(rosterReads, ['합성원정대']);
  assert.deepEqual(alt.art, dream); assert.equal(other.art, null); assert.deepEqual(english.art, dream); assert.deepEqual(anchor.art, dream);
  assert.equal(alt.status, 'ok'); assert.equal(alt.key, 'master'); assert.equal(alt.percentile, 4.77);
  await service.resolveTier('합성원정대둘', score); await service.resolveTier('라마바', score);
  assert.equal(rosterReads.length, 1);
  current += 6 * 60 * 60 * 1000 - 1; await service.resolveTier('합성원정대둘', score); assert.equal(rosterReads.length, 1);
  current += 1; assert.deepEqual((await service.resolveTier('합성원정대둘', score)).art, dream); assert.equal(rosterReads.length, 2);
  // (v) the fixed-cut path (no score) still carries the field.
  assert.deepEqual((await service.resolveTier('합성원정대둘', null)).art, dream);
  assert.equal((await service.resolveTier('합성원정대둘', null)).reason, 'score_unavailable');
  assert.equal((await service.resolveTier('가나닥', null)).art, null);
  service.close();
  assert.equal((await service.resolveTier('합성원정대', score)).art, null, 'closed services show no artwork');
  // (iv) a failing roster read never throws: the anchors stay marked, others wait for the retry ten minutes later.
  current = 1000; let failures = 0, mode = 'throw';
  const flaky = createCharacterEfficiencyService({ readDetails: async name => stored(name), readLopecScore: lopec, now: () => current,
    readRoster: async () => { failures++; if (mode === 'throw') throw new Error('boom'); if (mode === 'empty') return null;
      return { roster: { characters: [{ characterName: '합성원정대둘' }] } }; } });
  assert.equal((await flaky.resolveTier('합성원정대둘', score)).art, null); assert.deepEqual((await flaky.resolveTier('합성원정대', score)).art, dream);
  assert.equal(failures, 1);
  await flaky.resolveTier('합성원정대둘', score); assert.equal(failures, 1, 'no retry before ten minutes');
  current += 10 * 60 * 1000; mode = 'empty'; assert.equal((await flaky.resolveTier('합성원정대둘', score)).art, null); assert.equal(failures, 2);
  current += 10 * 60 * 1000; mode = 'ok'; assert.deepEqual((await flaky.resolveTier('합성원정대둘', score)).art, dream); assert.equal(failures, 3);
  // A later failure keeps the last good set instead of dropping the roster.
  current += 6 * 60 * 60 * 1000; mode = 'throw'; assert.deepEqual((await flaky.resolveTier('합성원정대둘', score)).art, dream); assert.equal(failures, 4);
  flaky.close();
  // A roster read that hangs past the tier timeout is a failure too, and the lopec tier still answers.
  const timers = [];
  const slow = createCharacterEfficiencyService({ readDetails: async name => stored(name), readLopecScore: lopec, tierTimeoutMs: 4000,
    readRoster: () => new Promise(() => {}), setTimer: fn => { timers.push(fn); return timers.length; }, clearTimer: () => {} });
  const pending = slow.resolveTier('합성원정대둘', score);
  await delay(5); for (const fire of timers.splice(0)) fire();
  const late = await pending; assert.equal(late.art, null); assert.equal(late.key, 'master'); assert.equal(late.basis, 'lopec'); slow.close();
});

test('tier falls back to the fixed cut when the lopec record score no longer matches the current score', async () => {
  const score = { status: 'ok', score: 4238.59, role: 'dealer', tier: classifyNativeSpecTier(4238.59) };
  const stored = { efficiency: { ...nativeResult('가나닥'), score } };
  const guarded = createCharacterEfficiencyService({ readDetails: async () => stored, now: () => 1000,
    readLopecScore: async () => ({ totalPercent: 0.19, totalRank: 3277, dbScore: 8428.219424347451 }) });
  const tier = (await guarded.get('가나닥')).tier; guarded.close();
  assert.equal(tier.status, 'unavailable'); assert.equal(tier.basis, 'fixed'); assert.equal(tier.reason, 'lopec_record_mismatch');
  assert.equal(tier.key, 'platinum'); assert.equal(tier.percentile, null); assert.deepEqual(tier.next, { key: 'diamond', name: '다이아몬드', percentile: 12 });
  assert.deepEqual(tier.reference, { source: '로펙 DB', score: 8428.22, percentile: 0.19, key: 'challenger', name: '챌린저', sampledAt: new Date(1000).toISOString() });
  // Within 3% the lopec rank still describes the equipment being scored.
  const close = createCharacterEfficiencyService({ readDetails: async () => stored, readLopecScore: async () => ({ totalPercent: 0.19, dbScore: 4238.59 * 1.02 }) });
  const near = (await close.get('가나닥')).tier; close.close();
  assert.equal(near.basis, 'lopec'); assert.equal(near.key, 'challenger'); assert.equal(near.reference, null);
  // A record far below the current score is a mismatch as well (stale lopec page).
  const stale = createCharacterEfficiencyService({ readDetails: async () => stored, readLopecScore: async () => ({ totalPercent: 40, dbScore: 3000 }) });
  assert.equal((await stale.get('가나닥')).tier.reason, 'lopec_record_mismatch'); stale.close();
  // Without a record score there is nothing to compare, so the rank is used as before.
  const noRecord = createCharacterEfficiencyService({ readDetails: async () => stored, readLopecScore: async () => ({ totalPercent: 0.19 }) });
  assert.equal((await noRecord.get('가나닥')).tier.basis, 'lopec'); noRecord.close();
});
