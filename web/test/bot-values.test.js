import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createWebServer } from '../src/server.js';
import { validateConfig } from '../src/config.js';
import { BOT_VALUES_PATH, botTokenMatches, isLoopbackAddress, parseBotParts, summarizeBotEfficiency, summarizeBotSpec, summarizeBotValuation } from '../src/bot-values.js';

const TOKEN = 'k'.repeat(48);

test('loopback address, token bytes and parts are checked exactly', () => {
  assert.ok(isLoopbackAddress('127.0.0.1') && isLoopbackAddress('::1') && isLoopbackAddress('::ffff:127.0.0.1'));
  assert.ok(!isLoopbackAddress('10.0.0.5') && !isLoopbackAddress(undefined));
  assert.ok(botTokenMatches(TOKEN, TOKEN));
  assert.ok(!botTokenMatches(TOKEN, TOKEN.slice(0, 47)) && !botTokenMatches(TOKEN, TOKEN + 'k') && !botTokenMatches(null, TOKEN) && !botTokenMatches('short', 'short'));
  assert.deepEqual([...parseBotParts(null)], ['efficiency', 'valuation']);
  assert.deepEqual([...parseBotParts('valuation')], ['valuation']);
  assert.equal(parseBotParts('efficiency,efficiency'), null);
  assert.equal(parseBotParts('score'), null);
  assert.deepEqual([...parseBotParts('spec')], ['spec']);
  assert.equal(parseBotParts(''), null);
});

test('configuration accepts a 32 to 128 character token and refuses anything else', () => {
  const base = { origin: 'https://opentalk.example.invalid', host: '127.0.0.1', port: 8090, dbPath: '/var/lib/opentalk-web/auth.sqlite', providers: {} };
  assert.equal(validateConfig(base).botInternalToken, null);
  assert.equal(validateConfig({ ...base, botInternalToken: '' }).botInternalToken, null);
  assert.equal(validateConfig({ ...base, botInternalToken: TOKEN }).botInternalToken, TOKEN);
  for (const bad of ['a'.repeat(31), 'a'.repeat(129), 'a'.repeat(32) + ' ', 'a'.repeat(32) + '!', 42]) {
    assert.throws(() => validateConfig({ ...base, botInternalToken: bad }), /bot token/);
  }
});

test('the efficiency and valuation summaries keep only the fields the commands print', () => {
  const efficiency = summarizeBotEfficiency({ bracelet: { status: 'ok', efficiency: 15.62, formulas: ['x'] },
    gem: { status: 'ok', efficiency: 9.41, optionEfficiency: 6.71, pointEfficiency: 2.52, diagnostics: {},
      effectEfficiencies: [{ name: '추가 피해', level: 52, effect: 4.2, efficiency: 3.23, description: 'd' }, { name: 7, effect: 1, efficiency: 1 }] } });
  assert.deepEqual(efficiency, { bracelet: { status: 'ok', efficiency: 15.62 },
    gem: { status: 'ok', efficiency: 9.41, optionEfficiency: 6.71, pointEfficiency: 2.52, effectEfficiencies: [{ name: '추가 피해', level: 52, effect: 4.2, efficiency: 3.23 }] } });
  assert.deepEqual(summarizeBotEfficiency({ bracelet: { status: 'absent', efficiency: null }, gem: { status: 'unavailable', efficiency: null } }),
    { bracelet: { status: 'unavailable', efficiency: null }, gem: { status: 'unavailable', efficiency: null, optionEfficiency: null, pointEfficiency: null, effectEfficiencies: [] } });
  assert.equal(summarizeBotEfficiency(null).gem.status, 'unavailable');

  const done = { status: 'done', characters: [{ characterName: '합성캐릭터4', state: 'done', value: { status: 'partial',
    braceletDetails: { record: { costExpectedGold: 30443366.4 } },
    components: { bracelet: { items: [{ id: 'bracelet', status: 'ok', expectedAcquisitionGold: 30443366.4 }] },
      arkgridGems: { complete: false, expectedAcquisitionGold: null, knownExpectedAcquisitionGold: 500000, counts: { items: 6, known: 4, unknown: 2 } } } } }] };
  assert.deepEqual(summarizeBotValuation(done), { status: 'done', bracelet: { gold: 30443366.4, record: true, reason: null },
    gems: { gold: null, knownGold: 500000, items: 6, known: 4, reason: 'partial' } });
  const none = { status: 'done', characters: [{ characterName: '합성캐릭터4', state: 'done', value: { status: 'ok', braceletDetails: null,
    components: { bracelet: { items: [] }, arkgridGems: { complete: true, expectedAcquisitionGold: 0, knownExpectedAcquisitionGold: 0, counts: { items: 0, known: 0, unknown: 0 } } } } }] };
  assert.deepEqual(summarizeBotValuation(none), { status: 'done', bracelet: { gold: null, record: false, reason: 'no_bracelet' }, gems: { gold: 0, knownGold: 0, items: 0, known: 0, reason: null } });
  const limited = { status: 'done', characters: [{ characterName: '합성캐릭터4', state: 'done', value: { status: 'unavailable', braceletDetails: null,
    components: { bracelet: { items: [{ id: 'bracelet', status: 'unavailable', reason: 'rate_limited' }] },
      arkgridGems: { complete: false, expectedAcquisitionGold: null, knownExpectedAcquisitionGold: 0, counts: { items: 1, known: 0, unknown: 1 }, items: [{ id: 'arkgrid-gems', status: 'unavailable', reason: 'rate_limited' }] } } } }] };
  assert.deepEqual(summarizeBotValuation(limited), { status: 'done', bracelet: { gold: null, record: false, reason: 'rate_limited' }, gems: { gold: null, knownGold: 0, items: 1, known: 0, reason: 'rate_limited' } });
  assert.deepEqual(summarizeBotValuation({ status: 'running', characters: [{ state: 'pending' }] }), { status: 'running' });
  assert.deepEqual(summarizeBotValuation({ status: 'done', characters: [{ state: 'error', value: null }] }), { status: 'unavailable' });
  assert.deepEqual(summarizeBotValuation(null), { status: 'unavailable' });
});

test('the spec summary keeps the score, tier wording inputs, best record and both efficiencies', () => {
  const profile = { characterName: '합성예제', serverName: '루페온', characterClass: '소울이터', itemLevel: 1805, combatPower: 12345.67, title: '칭호', guildName: '포근해', characterImage: 'https://cdn-lostark.game.onstove.com/armory/x.png', extra: 1 };
  const efficiency = { score: { status: 'ok', score: 9737.466802251844, role: 'dealer', modelVersion: '2026-09-16.1', assumptions: ['x'] },
    bracelet: { status: 'ok', efficiency: 16.16 }, gem: { status: 'ok', efficiency: 14.25, optionEfficiency: 1, pointEfficiency: 2, effectEfficiencies: [] } };
  const tier = { status: 'ok', key: 'esther', name: '에스더', rank: 10, basis: 'lopec', percentile: 0.001, source: '로펙 DB', reason: null, reference: null, next: null, cutsVersion: 'v' };
  const spec = summarizeBotSpec({ profile, efficiency, tier, record: { characterName: '합성예제', score: 9737.466802251844, role: 'dealer', modelVersion: 'm', recordedAt: 1000 } });
  assert.deepEqual(spec, { status: 'ok',
    profile: { characterName: '합성예제', serverName: '루페온', characterClass: '소울이터', itemLevel: 1805, combatPower: 12345.67, title: '칭호', guildName: '포근해', characterImage: 'https://cdn-lostark.game.onstove.com/armory/x.png' },
    score: { score: 9737.466802251844, role: 'dealer', modelVersion: '2026-09-16.1' }, omitted: [],
    tier: { key: 'esther', name: '에스더', status: 'ok', basis: 'lopec', percentile: 0.001, source: '로펙 DB', reason: null, next: null, reference: null, art: null },
    record: { score: 9737.47, recordedAt: 1000, current: true }, bracelet: { status: 'ok', efficiency: 16.16 }, gem: { status: 'ok', efficiency: 14.25 } });
  const mismatch = summarizeBotSpec({ profile: null, efficiency: { ...efficiency, score: { status: 'ok', score: 4238.59, role: 'dealer' } },
    tier: { status: 'unavailable', key: 'platinum', name: '플래티넘', basis: 'fixed', percentile: null, source: '고정 점수 구간', reason: 'lopec_record_mismatch', next: { key: 'diamond', name: '다이아몬드', percentile: 12 }, reference: { score: 8428.22, percentile: 0.19, key: 'challenger', name: '챌린저' } },
    record: { score: 8428.22, recordedAt: 5 } });
  assert.deepEqual(mismatch.tier, { key: 'platinum', name: '플래티넘', status: 'unavailable', basis: 'fixed', percentile: null, source: '고정 점수 구간', reason: 'lopec_record_mismatch', next: { name: '다이아몬드', percentile: 12 }, reference: { score: 8428.22, percentile: 0.19, name: '챌린저' }, art: null });
  // Custom artwork rides along untouched; anything that is not a known art entry reads as none.
  const art = { key: 'dream', name: '합성원정대', label: '합성원정대 전용 티어' };
  assert.deepEqual(summarizeBotSpec({ profile, efficiency, tier: { ...tier, art }, record: null }).tier.art, art);
  for (const bad of [{ key: 'esther', name: '에스더', label: 'x' }, { key: 'dream' }, { key: 'dream', name: '가'.repeat(13), label: 'x' }, 'dream', 7]) {
    const out = summarizeBotSpec({ profile, efficiency, tier: { ...tier, art: bad }, record: null }).tier.art;
    assert.ok(out === null || out.name === null, JSON.stringify(bad));
  }
  assert.equal(summarizeBotSpec({ profile, efficiency, tier: { ...tier, art: { key: 'esther', name: '에스더', label: 'x' } }, record: null }).tier.art, null);
  assert.deepEqual(mismatch.record, { score: 8428.22, recordedAt: 5, current: false }); assert.equal(mismatch.profile, null);
  const none = summarizeBotSpec({ profile, efficiency: { score: { status: 'unavailable', score: null, omitted: ['각인 이름·등급·레벨·중복 오류'] }, bracelet: { status: 'unavailable' }, gem: { status: 'unavailable' } }, tier: null, record: null });
  assert.equal(none.status, 'unavailable'); assert.equal(none.score, null); assert.equal(none.tier, null); assert.deepEqual(none.omitted, ['각인 이름·등급·레벨·중복 오류']);
});

test('the bot endpoint answers only a loopback request with the shared token and never through a session', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bot-values-web-'));
  const fetchImpl = async url => {
    assert.equal(new URL(url).origin, 'https://developer-lostark.game.onstove.com');
    if (new URL(url).pathname.endsWith('/profiles')) return Response.json({ CharacterName: '테스트캐릭터', CharacterClassName: '블레이드', ServerName: '루페온', ItemAvgLevel: '1,740.00' });
    return Response.json({ ArmoryProfile: { CharacterName: '테스트캐릭터', CharacterClassName: '블레이드', ServerName: '루페온', ItemAvgLevel: '1,740.00' },
      ArmoryEquipment: [], ArmoryGem: { Gems: [], Effects: null }, ArmoryEngraving: { ArkPassiveEffects: [] },
      ArkPassive: { IsArkPassive: false, Points: [], Effects: [] }, ArkGrid: { Slots: [], Effects: [] } });
  };
  const start = (botInternalToken) => {
    const app = createWebServer({ config: { origin: 'https://opentalk.example.invalid', host: '127.0.0.1', port: 0, dbPath: join(directory, `${botInternalToken ? 'on' : 'off'}.sqlite`),
      providers: {}, automaticApproval: { lostArkApiKey: 'synthetic-game-key' }, botInternalToken }, fetchImpl, readLopecScore: async () => null });
    app.server.listen(0, '127.0.0.1');
    return app;
  };
  const app = start(TOKEN), silent = start(undefined);
  await Promise.all([once(app.server, 'listening'), once(silent.server, 'listening')]);
  t.after(async () => { await app.close(); await silent.close(); await rm(directory, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const call = (query, headers = {}, method = 'GET', target = base) => fetch(`${target}${BOT_VALUES_PATH}${query}`, { method, headers });

  const missing = await call('?name=테스트캐릭터&parts=efficiency');
  assert.equal(missing.status, 404); assert.equal((await missing.json()).error, 'not_found');
  const wrong = await call('?name=테스트캐릭터&parts=efficiency', { 'X-Bot-Token': TOKEN.slice(0, 47) + 'x' });
  assert.equal(wrong.status, 404);
  const unset = await call('?name=테스트캐릭터&parts=efficiency', { 'X-Bot-Token': TOKEN }, 'GET', 'http://127.0.0.1:' + silent.server.address().port);
  assert.equal(unset.status, 404);
  const posted = await call('?name=테스트캐릭터&parts=efficiency', { 'X-Bot-Token': TOKEN }, 'POST');
  assert.equal(posted.status, 405);
  const bad = await call('?name=테스트캐릭터&parts=score', { 'X-Bot-Token': TOKEN });
  assert.equal(bad.status, 400);

  const spec = await call('?name=테스트캐릭터&parts=spec', { 'X-Bot-Token': TOKEN });
  assert.equal(spec.status, 200);
  const specBody = await spec.json();
  assert.deepEqual(Object.keys(specBody).sort(), ['characterName', 'spec', 'updatedAt']);
  assert.deepEqual(Object.keys(specBody.spec).sort(), ['bracelet', 'gem', 'omitted', 'profile', 'record', 'score', 'status', 'tier']);
  assert.equal(specBody.spec.status, 'unavailable'); assert.equal(specBody.spec.profile.characterName, '테스트캐릭터'); assert.equal(specBody.spec.record, null);

  const response = await call('?name=테스트캐릭터&parts=efficiency', { 'X-Bot-Token': TOKEN });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const data = await response.json();
  assert.equal(data.characterName, '테스트캐릭터');
  assert.deepEqual(Object.keys(data).sort(), ['characterName', 'efficiency', 'updatedAt']);
  assert.deepEqual(Object.keys(data.efficiency).sort(), ['bracelet', 'gem']);
  assert.equal(data.efficiency.bracelet.status, 'unavailable');
  assert.deepEqual(data.efficiency.gem, { status: 'unavailable', efficiency: null, optionEfficiency: null, pointEfficiency: null, effectEfficiencies: [] });

  const valuation = await call('?name=테스트캐릭터&parts=valuation', { 'X-Bot-Token': TOKEN });
  assert.equal(valuation.status, 200);
  const body = await valuation.json();
  assert.deepEqual(Object.keys(body).sort(), ['characterName', 'updatedAt', 'valuation']);
  assert.ok(['done', 'running', 'unavailable'].includes(body.valuation.status));
  if (body.valuation.status === 'done') assert.equal(body.valuation.bracelet.reason, 'no_bracelet');

  // The public route still needs a session even from loopback with the token.
  const guarded = await fetch(`${base}/api/lounge`, { headers: { 'X-Bot-Token': TOKEN } });
  assert.equal(guarded.status, 401);
});
