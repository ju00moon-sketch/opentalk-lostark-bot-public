import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import { createStore } from '../src/store.js';
import { createWebServer } from '../src/server.js';
import { createCharacterSpecupService, normalizeSpecupAnswer, CHARACTER_SPECUP_PATH } from '../src/character-specup.js';

// 캐릭터 화면 스펙업 탭: 계산은 봇이 하고, 가입 승인 회원만 읽는다. 봇 응답은 한 줄만 어긋나도 전부 버린다.
const origin = 'https://opentalk.example.invalid';
const digest = value => createHash('sha256').update(value).digest('hex');
const token = 'a'.repeat(40);
const timestamp = Date.parse('2026-09-21T14:00:00+09:00');

const row = (overrides = {}) => ({
  kind: '보석', option: '페이탈 웨이브 · 7레벨 겁화 → 8레벨 겁화', gainPercent: 0.98, gainSource: 'model',
  finalScore: 1246.6, expectedCost: 360_000, per100k: 0.27, priceSource: 'api',
  gem: { skill: '페이탈 웨이브', type: '피해', from: 7, to: 8 }, ...overrides,
});
const done = (overrides = {}) => ({
  status: 'done', name: '합성캐릭터4', startedAt: timestamp - 20_000, finishedAt: timestamp,
  guide: { baseScore: 1234.5, pricedAt: timestamp - 60_000, priceStale: false, droppedForPrice: 2,
    crystalPrice95: 17_000, rows: [row()] },
  crystal: { price95: 17_000, at: timestamp - 3600_000, source: 'auto' },
  ...overrides,
});
const guideWith = (...rows) => done({ guide: { ...done().guide, rows } });

test('판은 모든 줄이 계약에 맞을 때만 받아들인다', () => {
  const accepted = normalizeSpecupAnswer(done(), '합성캐릭터4');
  assert.equal(accepted.status, 'done');
  assert.equal(accepted.guide.rows.length, 1);
  assert.deepEqual(accepted.guide.rows[0].gem, { skill: '페이탈 웨이브', type: '피해', from: 7, to: 8 });

  // 비용 0인 행은 효율이 null이어야 하고, 보석이 아닌 행은 gem이 없어도 된다.
  assert.equal(normalizeSpecupAnswer(guideWith(row({ kind: '스톤', gem: undefined, priceSource: 'fixed', expectedCost: 0, per100k: null })), '합성캐릭터4').guide.rows.length, 1);
  // 로펙이 새 분류를 주어도 판을 버리지 않는다 — 보여 주기만 하는 글자다.
  assert.equal(normalizeSpecupAnswer(guideWith(row({ kind: '새분류', gem: undefined })), '합성캐릭터4').guide.rows[0].kind, '새분류');
  // 크리스탈 시세가 없는 판(페온 제외)도 정상이다.
  assert.equal(normalizeSpecupAnswer(done({ guide: { ...done().guide, crystalPrice95: null }, crystal: null }), '합성캐릭터4').crystal, null);

  assert.deepEqual(normalizeSpecupAnswer({ status: 'busy' }, '합성캐릭터4'), { status: 'busy' });
  const running = normalizeSpecupAnswer({ status: 'running', name: '합성캐릭터4', startedAt: timestamp, elapsedMs: 4210 }, '합성캐릭터4');
  assert.deepEqual(running, { status: 'running', startedAt: timestamp, elapsedMs: 4210 });
  assert.equal(normalizeSpecupAnswer({ status: 'unavailable', name: '합성캐릭터4', startedAt: timestamp - 100, finishedAt: timestamp }, '합성캐릭터4').status, 'unavailable');

  for (const [label, broken] of [
    ['빈 값', null], ['글자', 'board'], ['모르는 상태', { ...done(), status: 'queued' }],
    ['다른 캐릭터', done({ name: '합성캐릭터3' })],
    ['시작 시각 없음', done({ startedAt: null })],
    ['끝난 시각 없음', done({ finishedAt: 0 })],
    ['판 없음', done({ guide: null })],
    ['행이 배열 아님', done({ guide: { ...done().guide, rows: {} } })],
    ['기준 점수 0', done({ guide: { ...done().guide, baseScore: 0 } })],
    ['시세 기준이 숫자도 null도 아님', done({ guide: { ...done().guide, pricedAt: '어제' } })],
    ['갱신 지연이 참거짓 아님', done({ guide: { ...done().guide, priceStale: 'yes' } })],
    ['크리스탈 시세 범위 밖', done({ guide: { ...done().guide, crystalPrice95: 16 } })],
    ['행 상한 초과', done({ guide: { ...done().guide, rows: Array.from({ length: 201 }, () => row()) } })],
    ['항목 이름 없음', guideWith(row({ option: '' }))],
    ['딜 상승이 숫자 아님', guideWith(row({ gainPercent: '0.98' }))],
    ['비용이 음수', guideWith(row({ expectedCost: -1 }))],
    ['모르는 상승 출처', guideWith(row({ gainSource: 'guess' }))],
    ['모르는 시세 출처', guideWith(row({ priceSource: 'guess' }))],
    ['무료인데 효율이 있음', guideWith(row({ expectedCost: 0, per100k: 0.27 }))],
    ['비용이 있는데 효율이 없음', guideWith(row({ per100k: null }))],
    ['보석 종류가 아님', guideWith(row({ gem: { skill: '페이탈 웨이브', type: '방어', from: 7, to: 8 } }))],
    ['보석 레벨 범위 밖', guideWith(row({ gem: { skill: '페이탈 웨이브', type: '피해', from: 7, to: 11 } }))],
    ['시세 판이 객체 아님', done({ crystal: 17_000 })],
    ['시세 범위 밖', done({ crystal: { price95: 9, at: timestamp, source: 'auto' } })],
    ['계산 중인데 지난 시간 없음', { status: 'running', name: '합성캐릭터4', startedAt: timestamp }],
  ]) assert.equal(normalizeSpecupAnswer(broken, '합성캐릭터4'), null, label);
});

test('봇이 답하지 않거나 토큰이 없으면 조회 불가로 돌려준다', async () => {
  let reply = { ok: true, json: async () => done() }, calls = 0;
  const service = createCharacterSpecupService({ fetchImpl: async (url) => {
    calls += 1;
    assert.equal(url.pathname, '/internal/site/specup');
    assert.equal(url.searchParams.get('name'), '합성캐릭터4');
    if (reply === null) throw new Error('down');
    return reply;
  }, token, now: () => timestamp, base: 'http://127.0.0.1:9' });

  const first = await service.read('합성캐릭터4');
  assert.equal(first.status, 'done');
  assert.equal(first.checkedAt, timestamp);

  reply = null;
  assert.deepEqual(await service.read('합성캐릭터4'), { status: 'offline', checkedAt: timestamp });
  reply = { ok: false };
  assert.equal((await service.read('합성캐릭터4')).status, 'offline');
  // 모양이 어긋난 답도 조회 불가로 본다 — 반쯤 맞는 판을 화면에 넘기지 않는다.
  reply = { ok: true, json: async () => done({ guide: { ...done().guide, baseScore: 'many' } }) };
  assert.equal((await service.read('합성캐릭터4')).status, 'offline');
  assert.equal(calls, 4);

  let untouched = 0;
  const closed = createCharacterSpecupService({ fetchImpl: async () => { untouched += 1; return { ok: true, json: async () => done() }; }, token: null, now: () => timestamp });
  assert.equal((await closed.read('합성캐릭터4')).status, 'offline');
  assert.equal(untouched, 0, '토큰을 공유하지 않은 환경에서는 봇에 묻지 않는다');
});

async function setup(t, answer = done()) {
  const directory = await mkdtemp(join(tmpdir(), 'character-specup-'));
  const dbPath = join(directory, 'auth.sqlite');
  const store = createStore(dbPath);
  const accounts = {};
  for (const [index, name] of ['approved', 'outsider'].entries()) {
    const session = randomBytes(32).toString('base64url');
    store.createSession({ provider: 'discord', providerId: String(8300 + index), displayName: `회원 ${name}`,
      tokenHash: digest(session), expiresAt: timestamp + 86_400_000, epoch: 0 }, timestamp);
    accounts[name] = { ...store.getSession(digest(session), timestamp), session };
  }
  store.guild.bootstrapOwner(accounts.approved.id, timestamp);
  store.close();
  const asked = [];
  let served = answer;
  const bot = createServer((request, response) => {
    asked.push(request.url);
    response.writeHead(request.headers['x-bot-token'] === token ? 200 : 404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(served ?? { error: 'not_found' }));
  });
  bot.listen(0, '127.0.0.1');
  await once(bot, 'listening');
  const service = createWebServer({ config: { origin, host: '127.0.0.1', port: 0, dbPath, botInternalToken: token,
    providers: { kakao: { adminKey: 'private-test-key', appId: '12345' } } }, now: () => timestamp,
    botInternalUrl: `http://127.0.0.1:${bot.address().port}` });
  service.server.listen(0, '127.0.0.1');
  await once(service.server, 'listening');
  t.after(async () => {
    await service.close();
    await new Promise(resolve => bot.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const request = (account, query = '?name=합성캐릭터4', options = {}) =>
    fetch(`http://127.0.0.1:${service.server.address().port}${CHARACTER_SPECUP_PATH}${query}`, {
      ...options, headers: { ...(account ? { Cookie: `__Host-web_session=${account.session}` } : {}), ...options.headers },
    });
  return { accounts, request, asked, serve: value => { served = value; } };
}

test('가입 승인 회원만 스펙업 판을 읽는다', async (t) => {
  const { accounts, request, asked } = await setup(t);
  assert.equal((await request(null)).status, 401);
  assert.equal((await request(accounts.outsider)).status, 403);
  assert.equal(asked.length, 0, '회원이 아니면 봇에 묻지도 않는다');

  const response = await request(accounts.approved);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'done');
  assert.equal(body.guide.rows[0].kind, '보석');
  assert.equal(body.checkedAt, timestamp);
  assert.equal(asked[0], '/internal/site/specup?name=%ED%95%A9%EC%84%B1%EC%BA%90%EB%A6%AD%ED%84%B04');
});

test('이름이 없거나 모르는 질의는 400, 다른 출처는 403, 봇이 조용하면 offline', async (t) => {
  const { accounts, request, serve } = await setup(t);
  assert.equal((await request(accounts.approved, '')).status, 400);
  assert.equal((await request(accounts.approved, '?name=블레/99')).status, 400);
  assert.equal((await request(accounts.approved, '?name=합성캐릭터4&scope=roster')).status, 400);
  assert.equal((await request(accounts.approved, '?name=합성캐릭터4', { headers: { Origin: 'https://example.com' } })).status, 403);
  assert.equal((await request(accounts.approved, '?name=합성캐릭터4', { method: 'POST' })).status, 405);

  serve({ status: 'running', name: '합성캐릭터4', startedAt: timestamp, elapsedMs: 4210 });
  const running = await (await request(accounts.approved)).json();
  assert.equal(running.status, 'running');
  assert.equal(running.elapsedMs, 4210);

  serve({ status: 'running', name: '다른캐릭터', startedAt: timestamp, elapsedMs: 0 });
  assert.equal((await (await request(accounts.approved)).json()).status, 'offline', '다른 캐릭터의 판은 받지 않는다');
});
