import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import { createStore } from '../src/store.js';
import { createWebServer } from '../src/server.js';
import { HONING_PATH, createHoningService, normalizeHoningRequest } from '../src/honing-service.js';

// 도구 화면의 재련 최저 비용 계산기. 계산 자체는 봇 쪽 시험에서 검산하고 여기서는 경로와 입력만 본다.
const origin = 'https://opentalk.example.invalid';
const digest = value => createHash('sha256').update(value).digest('hex');
const timestamp = Date.parse('2026-09-21T22:00:00+09:00');

// Nginx가 웹으로 넘기는 접두사. 이 밖에 두면 정적 파일로 떨어져 404가 된다.
const PROXIED = ['/api/auth/', '/api/character/', '/api/market/'];
const priceRows = {
  50010: [
    { name: '운명의 파괴석', currentMinPrice: 169, bundleCount: 100 },
    { name: '운명의 수호석', currentMinPrice: 18, bundleCount: 100 },
    { name: '운명의 돌파석', currentMinPrice: 3, bundleCount: 1 },
    { name: '운명의 파편 주머니(대)', currentMinPrice: 143, bundleCount: 1 },
    { name: '아비도스 융화 재료', currentMinPrice: 30, bundleCount: 1 },
  ],
  50020: [
    { name: '용암의 숨결', currentMinPrice: 439, bundleCount: 1 },
    { name: '빙하의 숨결', currentMinPrice: 338, bundleCount: 1 },
    { name: '야금술 : 업화 [19-20]', currentMinPrice: 898, bundleCount: 1 },
    { name: '재봉술 : 업화 [19-20]', currentMinPrice: 666, bundleCount: 1 },
  ],
};
const stubMarket = (rows = priceRows) => ({
  calls: 0,
  async search({ category }) { this.calls += 1; const items = rows[category] ?? []; return { items, totalCount: items.length, pageSize: 10 }; },
});

test('경로는 Nginx가 웹으로 넘기는 접두사 아래에 있어야 한다', () => {
  assert.ok(PROXIED.some(prefix => HONING_PATH.startsWith(prefix)),
    `${HONING_PATH}는 프록시되지 않아 정적 404가 된다`);
});

test('입력은 부위와 두 단계만 받고 어긋나면 거절한다', () => {
  assert.deepEqual(normalizeHoningRequest({ kind: 'weapon', from: '18', to: '20' }), { kind: 'weapon', from: 18, to: 20 });
  for (const bad of [{}, { kind: '무기', from: 1, to: 2 }, { kind: 'weapon', from: 20, to: 20 },
    { kind: 'weapon', from: 20, to: 19 }, { kind: 'weapon', from: -1, to: 3 }, { kind: 'armor', from: 1, to: 26 }]) {
    assert.throws(() => normalizeHoningRequest(bad), /invalid_request/, JSON.stringify(bad));
  }
});

test('시세를 한 번 모아 5분 동안 다시 묻지 않고, 재료가 빠지면 캐시하지 않는다', async () => {
  let clock = timestamp;
  const market = stubMarket();
  const service = createHoningService({ market, now: () => clock });
  const first = await service.get({ kind: 'weapon', from: 18, to: 20 });
  assert.equal(first.kind, 'weapon');
  assert.ok(first.expectedGold > 0 && first.expectedGold < first.plainGold, '최저 비용이 맨몸보다 싸다');
  assert.equal(first.stages.length, 2);
  // 앞 열 줄로 자르면 뒤쪽 선택 전환이 사라지므로, 전체 계획에서 만든 구간을 넘긴다.
  const segments = first.stages[0].segments;
  assert.ok(Array.isArray(segments) && segments.length >= 1, '구간을 넘긴다');
  assert.equal(segments[0].from, 1);
  assert.equal(segments[segments.length - 1].to, first.stages[0].maximumAttempts, '마지막 구간이 계획 끝까지 덮는다');
  assert.ok(segments.every((s, i) => i === 0 || s.from === segments[i - 1].to + 1), '구간이 빈틈없이 이어진다');
  assert.equal(first.stages[0].plan, undefined, '잘린 계획은 더 넘기지 않는다');
  const calls = market.calls;
  clock += 60_000;
  await service.get({ kind: 'armor', from: 18, to: 19 });
  assert.equal(market.calls, calls, '캐시가 살아 있는 동안에는 다시 묻지 않는다');

  // 필수 재료가 빠진 판은 캐시하지 않고 조회 불가로 답한다.
  const thin = createHoningService({ market: stubMarket({ 50010: [], 50020: priceRows[50020] }), now: () => clock });
  await assert.rejects(() => thin.get({ kind: 'weapon', from: 18, to: 20 }), /honing_prices_unavailable/);
});

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'honing-http-'));
  const dbPath = join(directory, 'auth.sqlite');
  const store = createStore(dbPath);
  const accounts = {};
  for (const [index, name] of ['approved', 'outsider'].entries()) {
    const session = randomBytes(32).toString('base64url');
    store.createSession({ provider: 'discord', providerId: String(8400 + index), displayName: `회원 ${name}`,
      tokenHash: digest(session), expiresAt: timestamp + 86_400_000, epoch: 0 }, timestamp);
    accounts[name] = { ...store.getSession(digest(session), timestamp), session };
  }
  store.guild.bootstrapOwner(accounts.approved.id, timestamp);
  store.close();
  const service = createWebServer({ config: { origin, host: '127.0.0.1', port: 0, dbPath,
    providers: { kakao: { adminKey: 'private-test-key', appId: '12345' } } }, now: () => timestamp });
  service.server.listen(0, '127.0.0.1');
  await once(service.server, 'listening');
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const request = (account, query = '?kind=weapon&from=18&to=20') =>
    fetch(`http://127.0.0.1:${service.server.address().port}${HONING_PATH}${query}`,
      { headers: account ? { Cookie: `__Host-web_session=${account.session}` } : {} });
  return { accounts, request };
}

test('가입 승인 회원만 읽고, 모르는 질의는 거절한다', async (t) => {
  const { accounts, request } = await setup(t);
  assert.equal((await request(null)).status, 401);
  assert.equal((await request(accounts.outsider)).status, 403);
  // 승인 회원의 잘못된 입력은 400이며, 모르는 경로로 빠지지 않는다.
  for (const query of ['', '?kind=weapon', '?kind=weapon&from=18&to=20&extra=1', '?kind=칼&from=18&to=20']) {
    const status = (await request(accounts.approved, query)).status;
    assert.ok([400, 503].includes(status), `${query} → ${status}`);
  }
});

test('불완전한 판을 받으면 다음 조회는 하위 시장 캐시를 건너뛴다', async () => {
  // 우리 쪽에서 캐시하지 않아도 하위 market.search가 정상 형식의 빈 결과를 5분 캐시하면
  // 시세가 회복돼도 그 시간 동안 503이 이어진다. 그래서 불완전했던 다음 조회는 fresh로 요청한다.
  let clock = timestamp;
  let empty = true;
  const seen = [];
  const market = {
    async search({ category }, options = {}) {
      seen.push(options.fresh === true);
      const items = empty ? [] : (priceRows[category] ?? []);
      return { items, totalCount: items.length, pageSize: 10 };
    },
  };
  const service = createHoningService({ market, now: () => clock });
  await assert.rejects(() => service.get({ kind: 'weapon', from: 18, to: 20 }), /honing_prices_unavailable/);
  assert.ok(seen.every(fresh => fresh === false), '첫 조회는 캐시를 그대로 쓴다');

  // 시세가 돌아왔다. 5분을 기다리지 않고 바로 다시 조회해야 한다.
  empty = false;
  seen.length = 0;
  clock += 1000;
  const result = await service.get({ kind: 'weapon', from: 18, to: 20 });
  assert.equal(result.kind, 'weapon');
  assert.ok(seen.length > 0 && seen.every(fresh => fresh === true), `불완전 뒤에는 fresh로 묻는다: ${seen}`);

  // 완전한 판을 받은 뒤에는 다시 평소대로 캐시를 쓴다.
  seen.length = 0;
  clock += 1000;
  await service.get({ kind: 'armor', from: 18, to: 19 });
  assert.equal(seen.length, 0, '캐시가 살아 있는 동안에는 다시 묻지 않는다');
});
