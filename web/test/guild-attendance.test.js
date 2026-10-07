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
import { createAttendanceBoardService, normalizeAttendanceBoard } from '../src/attendance-board.js';

// 길드 화면의 카카오톡 출석 현황: 승인된 길드원만 읽고, 기록은 같은 기기의 봇에서 받아 짧게 캐시한다.
const origin = 'https://opentalk.example.invalid';
const digest = value => createHash('sha256').update(value).digest('hex');
const token = 'a'.repeat(40);
const timestamp = Date.parse('2026-09-20T14:00:00+09:00');
const board = (overrides = {}) => ({
  status: 'ok', room: '포근은행', month: '2026-09', date: '2026-09-20', todayCount: 1,
  members: [
    { rank: 1, name: '루현재/95', points: 46, count: 12, attendedToday: true, last: '2026-09-20' },
    { rank: 2, name: '합성캐릭터1/86', points: 35, count: 12, attendedToday: false, last: '2026-09-19' },
  ],
  ...overrides,
});

test('a board is only accepted when every row matches the contract', () => {
  assert.equal(normalizeAttendanceBoard(board()).members.length, 2);
  assert.equal(normalizeAttendanceBoard(board({ status: 'empty', members: [], todayCount: 0, room: null, month: null, date: null })).status, 'empty');
  for (const broken of [
    null, 'board', { ...board(), status: 'unavailable' }, { ...board(), status: 'ok', members: [] },
    { ...board(), todayCount: 5 }, { ...board(), month: '2026-9' }, { ...board(), date: '2026-09-20T00:00' },
    { ...board(), members: [{ rank: 2, name: '순서', points: 1, count: 1, attendedToday: false, last: null }] },
    { ...board(), members: [{ rank: 1, name: '', points: 1, count: 1, attendedToday: false, last: null }] },
    { ...board(), members: [{ rank: 1, name: '점수', points: -1, count: 1, attendedToday: false, last: null }] },
    { ...board(), members: [{ rank: 1, name: '오늘', points: 1, count: 1, attendedToday: 'yes', last: null }] },
    { ...board(), members: Array.from({ length: 201 }, (value, index) => ({ rank: index + 1, name: '많음', points: 1, count: 1, attendedToday: false, last: null })) },
  ]) assert.equal(normalizeAttendanceBoard(broken), null, String(broken && broken.status));
});

test('a room with more members than the list shows still produces a board', () => {
  // 봇은 순위 앞 200명까지만 보내고 전체 인원·오늘 출석은 자르기 전 수로 센다. 전에는 201명부터 판 전체를 버렸다.
  const members = Array.from({ length: 200 }, (value, index) => ({ rank: index + 1, name: `길드원${index + 1}`, points: 1, count: 1, attendedToday: true, last: '2026-09-20' }));
  const full = normalizeAttendanceBoard(board({ members, todayCount: 201, memberCount: 201 }));
  assert.equal(full.members.length, 200);
  assert.equal(full.memberCount, 201);
  assert.equal(full.todayCount, 201);
  // 전체 인원이 받은 줄보다 적거나 오늘 출석보다 적으면 어긋난 판이다.
  assert.equal(normalizeAttendanceBoard(board({ memberCount: 1 })), null);
  assert.equal(normalizeAttendanceBoard(board({ members, todayCount: 202, memberCount: 201 })), null);
  assert.equal(normalizeAttendanceBoard(board({ memberCount: -1 })), null);
  // 전체 인원을 보내지 않는 예전 봇은 받은 줄 수를 전체로 본다.
  assert.equal(normalizeAttendanceBoard(board()).memberCount, 2);
});

test('the service caches a good board, keeps serving it when the bot goes quiet, and stays closed without a token', async () => {
  let answer = board(), calls = 0, clock = timestamp;
  const fetchImpl = async () => {
    calls += 1;
    if (answer === null) throw new Error('down');
    return { ok: true, json: async () => answer };
  };
  const service = createAttendanceBoardService({ fetchImpl, token, now: () => clock, cacheMs: 30_000, base: 'http://127.0.0.1:9' });
  const first = await service.read();
  assert.equal(first.status, 'ok');
  assert.equal(first.stale, false);
  assert.equal(first.checkedAt, timestamp);
  clock += 10_000;
  assert.equal((await service.read()).checkedAt, timestamp);
  assert.equal(calls, 1, '캐시가 살아 있는 동안에는 봇에 다시 묻지 않는다');
  // 캐시가 지난 뒤 봇이 답하지 못하면 마지막 판을 stale로 표시해 그대로 보여 준다.
  clock += 30_000;
  answer = null;
  const stale = await service.read();
  assert.equal(calls, 2);
  assert.equal(stale.status, 'ok');
  assert.equal(stale.stale, true);
  assert.equal(stale.checkedAt, timestamp);
  // 모양이 어긋난 답도 실패로 본다.
  answer = board({ todayCount: 99 });
  clock += 30_000;
  assert.equal((await service.read()).stale, true);
  // 처음부터 못 받으면 비워 둔 판, 토큰이 없으면 아예 묻지 않는다.
  const cold = createAttendanceBoardService({ fetchImpl: async () => ({ ok: false }), token, now: () => clock, base: 'http://127.0.0.1:9' });
  assert.deepEqual(await cold.read(), { status: 'unavailable', room: null, month: null, date: null, todayCount: 0, memberCount: 0, members: [], checkedAt: null, stale: false });
  let untouched = 0;
  const closed = createAttendanceBoardService({ fetchImpl: async () => { untouched += 1; return { ok: true, json: async () => board() }; }, token: null, now: () => clock });
  assert.equal((await closed.read()).status, 'unavailable');
  assert.equal(untouched, 0);
});

async function setup(t, answer = board()) {
  const directory = await mkdtemp(join(tmpdir(), 'guild-attendance-'));
  const dbPath = join(directory, 'auth.sqlite');
  const store = createStore(dbPath);
  const accounts = {};
  for (const [index, name] of ['approved', 'outsider'].entries()) {
    const session = randomBytes(32).toString('base64url');
    store.createSession({ provider: 'discord', providerId: String(8100 + index), displayName: `회원 ${name}`,
      tokenHash: digest(session), expiresAt: timestamp + 86_400_000, epoch: 0 }, timestamp);
    accounts[name] = { ...store.getSession(digest(session), timestamp), session };
  }
  store.guild.bootstrapOwner(accounts.approved.id, timestamp);
  store.close();
  let served = answer;
  const bot = createServer((request, response) => {
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
  const request = (account, path = '/api/auth/guild/attendance', options = {}) => fetch(`http://127.0.0.1:${service.server.address().port}${path}`, {
    ...options, headers: { ...(account ? { Cookie: `__Host-web_session=${account.session}` } : {}), ...options.headers },
  });
  return { accounts, request };
}

test('only an approved guild member reads the attendance board over the website', async (t) => {
  const { accounts, request } = await setup(t);
  assert.equal((await request(null)).status, 401);
  assert.equal((await request(accounts.outsider)).status, 403);
  const response = await request(accounts.approved);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.room, '포근은행');
  assert.equal(body.todayCount, 1);
  assert.equal(body.stale, false);
  assert.deepEqual(body.members.map(member => member.name), ['루현재/95', '합성캐릭터1/86']);
  // 이 경로는 물음표 조건이나 쓰기를 받지 않는다.
  assert.equal((await request(accounts.approved, '/api/auth/guild/attendance?room=%ED%8F%AC')).status, 400);
  const rejected = await request(accounts.approved, '/api/auth/guild/attendance', { method: 'POST', headers: { Origin: origin } });
  assert.equal(rejected.status, 405);
  assert.equal(rejected.headers.get('allow'), 'GET');
});

test('a bot that cannot answer leaves the website with an empty board instead of an error page', async (t) => {
  const { accounts, request } = await setup(t, null);
  const response = await request(accounts.approved);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'unavailable');
  assert.deepEqual(body.members, []);
  assert.equal(body.checkedAt, null);
});
