import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { readRoomAttendance } from '../src/attendance.js';
import { isLoopbackAddress, siteAttendanceBoard, siteTokenMatches, ATTENDANCE_SITE_PATH } from '../src/attendance-site.js';
import { startKakaoServer } from '../src/kakao/server.js';
import { listenOnFreePort } from './helpers/free-port.mjs';

// 홈페이지 길드 화면이 읽는 출석 현황. 방 식별자 없이 저장 키로 읽고, 공개할 방 하나만 내보낸다.
const now = () => Date.parse('2026-09-20T14:00:00+09:00');
const nextMonth = () => Date.parse('2026-10-01T09:00:00+09:00');
const member = (name, points, count, last) => ({ name, points, count, last });
const store = () => ({
  version: 4,
  rooms: {
    포근은행: {
      'kakao:oc:루현재': member('루현재/95', 46, 12, '2026-09-20'),
      'kakao:oc:합성캐릭터1': member('합성캐릭터1/86', 35, 12, '2026-09-19'),
      'kakao:oc:같은점수': member('같은점수', 35, 9, '2026-09-18'),
      'kakao:oc:지난달': member('지난달', 99, 30, '2026-08-31'),
    },
    '합성캐릭터4/99': { 'kakao:oc:합성캐릭터4': member('합성캐릭터4/99', 3, 1, '2026-09-13') },
  },
  legacy: { 옛기록: { points: 5, count: 3, last: '2026-08-01' } },
  roomBindings: {},
});

function fixture(t, data = store()) {
  const directory = mkdtempSync(join(tmpdir(), 'site-attendance-'));
  const storePath = join(directory, 'attendance.json');
  writeFileSync(storePath, JSON.stringify(data));
  t.after(() => {
    for (const file of readdirSync(directory)) unlinkSync(join(directory, file));
    rmdirSync(directory);
  });
  return { storePath, raw: () => readFileSync(storePath, 'utf8') };
}

// 빈 포트를 찾아 바로 붙잡는다. KAKAO_PORT는 0을 "꺼짐"으로 읽으므로 번호를 먼저 알아내야 하는데,
// 그 사이 다른 시험이 같은 번호를 채 갈 수 있다. 서버가 못 올라오면 다른 번호로 다시 시도한다.
const startOnFreePort = (env) =>
  listenOnFreePort((port) => startKakaoServer(new Map(), { ...env, KAKAO_PORT: String(port) }));

test('one room reads as this month only, ranked by points then count then name, without touching the file', (t) => {
  const { storePath, raw } = fixture(t);
  const before = raw();
  const board = readRoomAttendance('포근은행', { now, storePath });
  assert.deepEqual(board.members.map((entry) => entry.name), ['루현재/95', '합성캐릭터1/86', '같은점수']);
  assert.equal(board.roomName, '포근은행');
  assert.equal(board.date, '2026-09-20');
  assert.equal(board.todayCount, 1);
  assert.deepEqual(board.members.map((entry) => entry.attendedToday), [true, false, false]);
  // 저장 키를 모르는 방은 null이고, 조회만으로는 파일이 바뀌지 않는다.
  assert.equal(readRoomAttendance('없는 방', { now, storePath }), null);
  assert.equal(readRoomAttendance('합성캐릭터4/99', { now, storePath }).members.length, 1);
  assert.equal(raw(), before);
});

test('the site board carries display fields only and says why it is empty', (t) => {
  const { storePath } = fixture(t);
  const board = siteAttendanceBoard({ room: '포근은행', now, storePath });
  assert.equal(board.status, 'ok');
  assert.equal(board.room, '포근은행');
  assert.equal(board.month, '2026-09');
  assert.equal(board.todayCount, 1);
  assert.deepEqual(board.members[0], { rank: 1, name: '루현재/95', points: 46, count: 12, attendedToday: true, last: '2026-09-20' });
  assert.deepEqual(board.members.map((entry) => entry.rank), [1, 2, 3]);
  // 카카오 사용자 키는 홈페이지로 내보내지 않는다.
  assert.ok(board.members.every((entry) => !Object.hasOwn(entry, 'userId')));
  // 공개할 방을 정하지 않으면 아무것도 읽지 않고, 다음 달로 넘어가면 이번 달 기록이 비어 있다고 답한다.
  assert.equal(siteAttendanceBoard({ room: '', now, storePath }).status, 'disabled');
  assert.equal(siteAttendanceBoard({ room: '   ', now, storePath }).room, null);
  assert.equal(siteAttendanceBoard({ room: '없는 방', now, storePath }).status, 'empty');
  const rolled = siteAttendanceBoard({ room: '포근은행', now: nextMonth, storePath });
  assert.equal(rolled.status, 'empty');
  assert.deepEqual(rolled.members, []);
  assert.equal(rolled.todayCount, 0);
});

test('a room bigger than the list limit sends the first 200 rows with whole-room counts', (t) => {
  // 전에는 명단만 200명으로 자르고 todayCount는 201로 보내 홈페이지가 판 전체를 버렸다.
  const crowd = Object.fromEntries(Array.from({ length: 201 }, (value, index) =>
    [`kakao:oc:${index}`, member(`길드원${index}`, 1, 1, '2026-09-20')]));
  const { storePath } = fixture(t, { version: 4, rooms: { 포근은행: crowd }, legacy: {}, roomBindings: {} });
  const board = siteAttendanceBoard({ room: '포근은행', now, storePath });
  assert.equal(board.members.length, 200);
  assert.equal(board.memberCount, 201);
  assert.equal(board.todayCount, 201);
  assert.ok(board.todayCount <= board.memberCount);
  assert.equal(siteAttendanceBoard({ room: '', now, storePath }).memberCount, 0);
});

test('the loopback check and the shared token both have to match', () => {
  const token = 'a'.repeat(40);
  assert.ok(isLoopbackAddress('127.0.0.1') && isLoopbackAddress('::1') && isLoopbackAddress('::ffff:127.0.0.1'));
  assert.ok(!isLoopbackAddress('10.0.0.7') && !isLoopbackAddress(undefined));
  assert.ok(siteTokenMatches(token, token));
  assert.ok(!siteTokenMatches(token, `${token}b`) && !siteTokenMatches(token, 'a'.repeat(39)));
  assert.ok(!siteTokenMatches('', '') && !siteTokenMatches('short', 'short') && !siteTokenMatches(token, undefined));
});

test('the bot serves the board to a loopback caller with the token and hides the route otherwise', async (t) => {
  const token = 'b'.repeat(40);
  const { server, port } = await startOnFreePort({
    KAKAO_SKILL_SECRET: 'test-secret', PUBLIC_BASE_URL: 'http://127.0.0.1',
    BOT_INTERNAL_TOKEN: token, KAKAO_ATTENDANCE_ROOM: '포근은행',
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${port}${ATTENDANCE_SITE_PATH}`;
  const call = (options = {}) => fetch(url, options);
  assert.equal((await call()).status, 404);
  assert.equal((await call({ headers: { 'X-Bot-Token': 'c'.repeat(40) } })).status, 404);
  const allowed = await call({ headers: { 'X-Bot-Token': token } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('cache-control'), 'no-store');
  const board = await allowed.json();
  // 이 시험은 실제 저장 파일을 쓰지 않으므로 내용이 아니라 계약만 확인한다.
  assert.ok(['ok', 'empty'].includes(board.status));
  assert.equal(board.room, '포근은행');
  assert.ok(Array.isArray(board.members));
  const rejected = await call({ method: 'POST', headers: { 'X-Bot-Token': token } });
  assert.equal(rejected.status, 405);
  assert.equal(rejected.headers.get('allow'), 'GET');
});
