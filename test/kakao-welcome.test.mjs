import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWelcomeHandler, formatPreviousEntry, formatWelcome, parseWelcomeEvent, parseWelcomeJson, welcomeId } from '../src/kakao/welcome.js';
import { WelcomeStore } from '../src/kakao/welcome-store.js';

const NOW = Date.parse('2026-09-12T10:41:33Z');
const ROOM = '123456789012345678';
const ROOM_NAME = '포근은행';
const MEMBER = '111110000000000001';
const BOT = '500';
function event({ id = '100', room = ROOM, actor = '700', origin = 'NEWMEM', at = NOW,
  members = [{ userId: MEMBER, nickName: '화사한 뇽냥/95' }], feedType = 4, type = '0' } = {}) {
  return { msg: 'untrusted display text', sender: 'not the joining member', json: {
    id, chat_id: room, user_id: actor, created_at: String(Math.floor(at / 1000)), type,
    v: JSON.stringify({ origin }), message: origin === 'MSG' ? 'PRIVATE_BODY_NEVER_STORE'
      : JSON.stringify({ feedType, members }),
  } };
}
function setup(t, options = {}) {
  const store = options.store ?? new WelcomeStore(':memory:');
  const rooms = options.rooms ?? [ROOM];
  store.baseline(BOT, rooms, NOW - 30_000);
  t.after(() => store.close());
  const calls = { names: [], roomNames: [], replies: [] };
  const iris = { async getBotId() { return BOT; },
    async getRoomName(room) { calls.roomNames.push(room); return ROOM_NAME; },
    async getName(room, id) { calls.names.push([room, id]); return '화사한 뇽냥/95'; },
    async reply(...args) { calls.replies.push(args); }, ...options.iris };
  const handle = createWelcomeHandler({ store, iris, rooms, botId: BOT, now: () => NOW,
    startedAt: NOW - 30_000, ...options, store, iris });
  return { store, calls, handle, iris };
}

test('greeting and previous actual entry are two distinct messages', () => {
  assert.equal(formatWelcome('화사한 뇽냥/95', ROOM_NAME), '화사한 뇽냥/95님 "포근은행"에 어서오세요!\n즐거운 길드 생활 되세요!');
  assert.equal(formatWelcome('합성캐릭터4/99', '포근운수2호점'),
    '합성캐릭터4/99님 "포근운수2호점"에 어서오세요!\n즐거운 길드 생활 되세요!');
  assert.equal(formatPreviousEntry({ name: '화사한 뇽냥', at: NOW }),
    '이전 이름: 화사한 뇽냥\n날짜: 2026-09-12 19:41:33');
});

test('64-bit JSON IDs are lossless; already-rounded numeric objects are rejected', () => {
  const input = parseWelcomeJson('{"id":111110000000000001}');
  assert.equal(input.id, MEMBER);
  assert.throws(() => welcomeId(Number(MEMBER)), /INVALID_ID/);
  assert.throws(() => welcomeId('9223372036854775808'), /INVALID_ID/);
  const e = event();
  e.json.message = '{"feedType":4,"members":[{"userId":111110000000000001,"nickName":"이름"}]}';
  assert.equal(parseWelcomeEvent(e).members[0].id, MEMBER);
});

test('join comes only from OPENLINK_JOIN members, never sender, text, or invitedUsers', () => {
  assert.equal(parseWelcomeEvent(event()).members[0].id, MEMBER);
  assert.equal(parseWelcomeEvent(event({ origin: 'MSG' })).kind, 'message');
  for (const e of [event({ feedType: 1 }), event({ type: '1' }), event({ members: [] })])
    assert.throws(() => parseWelcomeEvent(e));
  const e = event(); e.json.message = '{"feedType":4,"invitedUsers":[{"userId":"100"}]}';
  assert.throws(() => parseWelcomeEvent(e), /JOIN_MEMBERS_REQUIRED/);
});

test('default simulation welcomes actual member with no historical nickname', async (t) => {
  const { handle, calls } = setup(t);
  const result = await handle(event());
  assert.deepEqual(calls.names, [[ROOM, MEMBER]]);
  assert.deepEqual(calls.roomNames, [ROOM]);
  assert.equal(calls.replies.length, 0);
  assert.equal(result.results[0].memberId, MEMBER);
  assert.deepEqual(result.results[0].messages, ['화사한 뇽냥/95님 "포근은행"에 어서오세요!\n즐거운 길드 생활 되세요!']);
});

test('ordinary messages only observe names and never persist bodies', async (t) => {
  const { handle, store, calls } = setup(t);
  assert.equal((await handle(event({ origin: 'MSG', actor: MEMBER }))).status, 'observed_name');
  assert.equal(calls.replies.length, 0);
  assert.equal(store.member(ROOM, MEMBER).name, '화사한 뇽냥/95');
  for (const table of ['members', 'events', 'name_history', 'welcomes', 'entries', 'welcome_messages'])
    assert.ok(!JSON.stringify(store.db.prepare(`SELECT * FROM ${table}`).all()).includes('PRIVATE_BODY_NEVER_STORE'));
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM entries').get().count, 0);
});

test('system-authored joins need member IDs but no message author identity', async (t) => {
  const { handle, calls } = setup(t);
  const result = await handle(event({ actor: '0' }));
  assert.equal(result.results[0].memberId, MEMBER);
  assert.deepEqual(calls.names, [[ROOM, MEMBER]]);
  const missingAuthor = event({ id: '101' });
  delete missingAuthor.json.user_id;
  assert.equal(parseWelcomeEvent(missingAuthor).members[0].id, MEMBER);
  assert.throws(() => parseWelcomeEvent(event({ actor: '0', origin: 'MSG' })), /INVALID_ID/);
});

test('baseline and ordinary nickname observations do not count as earlier entries', async (t) => {
  let name = '화사한 뇽냥';
  const { handle, store } = setup(t, { iris: { async getName() { return name; } } });
  await handle(event({ id: '90', origin: 'MSG', actor: MEMBER, at: NOW - 2_000 }));
  name = '화사한 뇽냥/95';
  await handle(event({ id: '91', origin: 'MSG', actor: MEMBER, at: NOW - 1_000 }));
  const result = await handle(event());
  assert.deepEqual(result.results[0].messages, ['화사한 뇽냥/95님 "포근은행"에 어서오세요!\n즐거운 길드 생활 되세요!']);
  assert.equal(store.db.prepare('SELECT previous_name FROM welcomes').get().previous_name, null);
});

test('same-name reentry includes the immediately preceding actual entry time', async (t) => {
  const { handle, store } = setup(t);
  await handle(event({ id: '90', at: NOW - 2_000 }));
  const second = await handle(event({ id: '91', at: NOW - 1_000 }));
  assert.deepEqual(second.results[0].messages, ['화사한 뇽냥/95님 "포근은행"에 어서오세요!\n즐거운 길드 생활 되세요!',
    '이전 이름: 화사한 뇽냥/95\n날짜: 2026-09-12 19:41:31']);
  assert.deepEqual((await handle(event())).results[0].messages, ['화사한 뇽냥/95님 "포근은행"에 어서오세요!\n즐거운 길드 생활 되세요!',
    '이전 이름: 화사한 뇽냥/95\n날짜: 2026-09-12 19:41:32']);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM entries').get().count, 3);
});

test('entry name is preserved when a profile has already changed after the feed', async (t) => {
  const { handle, store } = setup(t, { iris: { async getName() { return '입장 후 이름'; } } });
  const result = await handle(event());
  assert.deepEqual(result.results[0].messages, ['화사한 뇽냥/95님 "포근은행"에 어서오세요!\n즐거운 길드 생활 되세요!']);
  assert.equal(store.member(ROOM, MEMBER).name, '입장 후 이름');
  assert.deepEqual(store.previousEntry(ROOM, MEMBER, NOW + 1_000, '101'),
    { name: '화사한 뇽냥/95', at: NOW, eventId: '100' });
});

test('unlisted rooms are rejected before profiles or content parsing; room histories are isolated', async (t) => {
  const { handle, calls, store } = setup(t);
  const forbidden = event({ room: '20' }); forbidden.json.message = 'invalid JSON';
  assert.equal((await handle(forbidden)).status, 'ignored_room');
  assert.equal(calls.names.length, 0);
  assert.equal(calls.roomNames.length, 0);
  store.updateName('20', MEMBER, '다른 방 이름', NOW);
  store.prepareJoin(parseWelcomeEvent(event({ room: '20', id: '90', at: NOW - 1_000 })),
    [{ id: MEMBER, name: '다른 방 입장', latestName: '다른 방 이름' }], 'simulated', ROOM_NAME);
  assert.deepEqual((await handle(event())).results[0].messages, ['화사한 뇽냥/95님 "포근은행"에 어서오세요!\n즐거운 길드 생활 되세요!']);
});

test('fresh room names stay isolated and renaming affects only later greetings', async (t) => {
  const otherRoom = '123456789012345679';
  const roomNames = new Map([[ROOM, '포근은행'], [otherRoom, '포근운수2호점']]);
  const { handle, store } = setup(t, { rooms: [ROOM, otherRoom], iris: {
    async getRoomName(room) { return roomNames.get(room); },
  } });
  const first = await handle(event({ id: '90', at: NOW - 2000 }));
  const other = await handle(event({ room: otherRoom, id: '90', at: NOW - 1000 }));
  assert.deepEqual(first.results[0].messages, ['화사한 뇽냥/95님 "포근은행"에 어서오세요!\n즐거운 길드 생활 되세요!']);
  assert.deepEqual(other.results[0].messages, ['화사한 뇽냥/95님 "포근운수2호점"에 어서오세요!\n즐거운 길드 생활 되세요!']);
  roomNames.set(ROOM, '새 "길드" 톡방');
  const renamed = await handle(event());
  assert.deepEqual(renamed.results[0].messages, ['화사한 뇽냥/95님 "새 "길드" 톡방"에 어서오세요!\n즐거운 길드 생활 되세요!',
    '이전 이름: 화사한 뇽냥/95\n날짜: 2026-09-12 19:41:31']);
  assert.equal(store.db.prepare('SELECT text FROM welcome_messages WHERE room_id=? AND event_id=?').get(ROOM, '90').text,
    first.results[0].messages[0]);
});

test('missing or invalid room names stop before reserving or sending any greeting', async (t) => {
  for (const name of [undefined, null, '', ' ', 123, '다른\n가짜 방']) {
    const { handle, store, calls } = setup(t, { send: true, iris: { async getRoomName() { return name; } } });
    await assert.rejects(handle(event()), /INVALID_ROOM_NAME/);
    assert.equal(store.hasEvent(ROOM, '100'), false);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM welcome_messages').get().count, 0);
    assert.deepEqual(calls.replies, []);
    assert.deepEqual(calls.names, []);
  }
  const missing = setup(t, { send: true, iris: { getRoomName: undefined } });
  await assert.rejects(missing.handle(event()), /ROOM_NAME_LOOKUP_REQUIRED/);
  assert.equal(missing.store.hasEvent(ROOM, '100'), false);
  const unavailable = setup(t, { send: true, iris: { async getRoomName() { throw new Error('lookup failed'); } } });
  await assert.rejects(unavailable.handle(event()), /lookup failed/);
  assert.equal(unavailable.store.hasEvent(ROOM, '100'), false);
  assert.deepEqual(unavailable.calls.replies, []);
});

test('an account change during room-name lookup cannot reserve a greeting', async (t) => {
  let bot = BOT;
  const { handle, store, calls } = setup(t, { send: true, iris: {
    async getBotId() { return bot; },
    async getRoomName() { bot = '501'; return ROOM_NAME; },
  } });
  await assert.rejects(handle(event()), /IRIS_ACCOUNT_CHANGED/);
  assert.equal(store.hasEvent(ROOM, '100'), false);
  assert.deepEqual(calls.replies, []);
});

test('stale startup/age events are skipped and future timestamps rejected', async (t) => {
  const { handle, calls } = setup(t);
  assert.equal((await handle(event({ at: NOW - 31_000 }))).status, 'stale');
  assert.equal((await handle(event({ at: NOW - 180_000 }))).status, 'stale');
  await assert.rejects(handle(event({ at: NOW + 6_000 })), /FUTURE_EVENT/);
  assert.equal(calls.names.length, 0);
});

test('fresh reordered joins still welcome without rewinding a newer member observation', async (t) => {
  const { handle, store } = setup(t, { iris: { async getName() { return '더 새 이름'; } } });
  store.updateName(ROOM, MEMBER, '더 새 이름', NOW);
  const result = await handle(event({ at: NOW - 1_000 }));
  assert.equal(result.results.length, 1);
  assert.equal(store.member(ROOM, MEMBER).name, '더 새 이름');
});

test('duplicate concurrent delivery sends each member once in order', async (t) => {
  const { handle, calls } = setup(t, { send: true });
  const e = event({ members: [{ userId: MEMBER, nickName: '첫째' }, { userId: '200', nickName: '둘째' }] });
  const results = await Promise.all([handle(e), handle(e)]);
  assert.equal(results[1].status, 'duplicate');
  assert.deepEqual(calls.replies.map((args) => args[1]), ['첫째님 "포근은행"에 어서오세요!\n즐거운 길드 생활 되세요!', '둘째님 "포근은행"에 어서오세요!\n즐거운 길드 생활 되세요!']);
  assert.equal(results[0].results[0].status, 'confirmed_in_iris');
});

test('profile failure resolves no partial join snapshot or outgoing message', async (t) => {
  const { handle, store, calls } = setup(t, { send: true, iris: {
    async getName(_room, id) { if (id === '200') throw new Error('missing'); return '첫째'; },
  } });
  await assert.rejects(handle(event({ members: [{ userId: MEMBER, nickName: '첫째' }, { userId: '200', nickName: '둘째' }] })));
  assert.equal(store.hasEvent(ROOM, '100'), false);
  assert.equal(calls.replies.length, 0);
  assert.equal(store.member(ROOM, MEMBER), undefined);
});

test('ambiguous delivery is not retried and blocks subsequent live replies', async (t) => {
  let attempts = 0;
  const { handle, store } = setup(t, { send: true, iris: { async reply() { attempts++; throw new Error('timeout'); } } });
  assert.equal((await handle(event())).results[0].status, 'uncertain');
  assert.equal((await handle(event())).status, 'duplicate');
  await assert.rejects(handle(event({ id: '101' })), /UNCONFIRMED_REPLY_REQUIRES_REVIEW/);
  assert.equal(attempts, 1);
  assert.equal(store.hasUnconfirmed(), true);
});

test('reentry waits for greeting confirmation before sending the previous-entry message', async (t) => {
  let releaseGreeting;
  const confirmed = new Promise((resolve) => { releaseGreeting = resolve; });
  const sent = [];
  const { handle, store } = setup(t, { send: true, iris: { async reply(_room, text) {
    sent.push(text);
    if (sent.length === 1) await confirmed;
  } } });
  store.prepareJoin(parseWelcomeEvent(event({ id: '90', at: NOW - 2_000 })),
    [{ id: MEMBER, name: '입장 당시 이름', latestName: '조회 당시 이름' }], 'simulated', ROOM_NAME);
  const running = handle(event());
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, ['화사한 뇽냥/95님 "포근은행"에 어서오세요!\n즐거운 길드 생활 되세요!']);
  assert.equal(store.hasUnconfirmed(), true);
  releaseGreeting();
  assert.equal((await running).results[0].status, 'confirmed_in_iris');
  assert.deepEqual(sent, ['화사한 뇽냥/95님 "포근은행"에 어서오세요!\n즐거운 길드 생활 되세요!',
    '이전 이름: 입장 당시 이름\n날짜: 2026-09-12 19:41:31']);
  assert.equal(store.hasUnconfirmed(), false);
});

test('second-message failure stops the batch, preserves snapshots, and never repeats the greeting', async (t) => {
  const sent = [];
  const { handle, store } = setup(t, { send: true, iris: { async reply(_room, text) {
    sent.push(text); if (sent.length === 2) throw new Error('connection lost after accepting the message');
  } } });
  store.prepareJoin(parseWelcomeEvent(event({ id: '90', at: NOW - 2_000 })),
    [{ id: MEMBER, name: '이전 입장 이름', latestName: '다른 프로필 이름' }], 'simulated', ROOM_NAME);
  const e = event({ members: [{ userId: MEMBER, nickName: '지금 입장 이름' }, { userId: '200', nickName: '다음 사람' }] });
  const result = await handle(e);
  assert.deepEqual(result.results.map((item) => item.status), ['uncertain', 'reserved']);
  assert.deepEqual(store.db.prepare('SELECT status FROM welcome_messages WHERE event_id=? ORDER BY sequence').all('100')
    .map((row) => row.status), ['confirmed_in_iris', 'uncertain', 'reserved']);
  assert.equal((await handle(e)).status, 'duplicate');
  await assert.rejects(handle(event({ id: '101' })), /UNCONFIRMED_REPLY_REQUIRES_REVIEW/);
  assert.equal(sent.length, 2);
  assert.equal(store.previousEntry(ROOM, MEMBER, NOW + 1_000, '101').name, '지금 입장 이름');
  assert.equal(store.previousEntry(ROOM, '200', NOW + 1_000, '101').name, '다음 사람');
});

test('a changed nickname uses the prior entry snapshot, never intervening observations', async (t) => {
  let name = '조회한 이름';
  const { handle, store } = setup(t, { iris: { async getName() { return name; } } });
  await handle(event({ id: '90', at: NOW - 2_000, members: [{ userId: MEMBER, nickName: '첫 입장 이름' }] }));
  name = '중간 대화 이름';
  await handle(event({ id: '91', at: NOW - 1_000, origin: 'MSG', actor: MEMBER }));
  name = '입장 이후 조회 이름';
  const result = await handle(event({ members: [{ userId: MEMBER, nickName: '재입장 이름' }] }));
  assert.deepEqual(result.results[0].messages, ['재입장 이름님 "포근은행"에 어서오세요!\n즐거운 길드 생활 되세요!',
    '이전 이름: 첫 입장 이름\n날짜: 2026-09-12 19:41:31']);
  const row = store.db.prepare('SELECT previous_name,previous_at,name,occurred_at FROM welcomes WHERE event_id=?').get('100');
  assert.deepEqual({ ...row }, { previous_name: '첫 입장 이름', previous_at: NOW - 2_000,
    name: '재입장 이름', occurred_at: NOW });
});

test('reordered entry feeds and same-second IDs never select a future entry or rewind the latest', async (t) => {
  const { handle, store } = setup(t);
  await handle(event({ id: '80', at: NOW - 3_000, members: [{ userId: MEMBER, nickName: '처음' }] }));
  await handle(event({ id: '91', at: NOW - 1_000, members: [{ userId: MEMBER, nickName: '최신' }] }));
  const older = await handle(event({ id: '90', at: NOW - 2_000, members: [{ userId: MEMBER, nickName: '늦게 수신' }] }));
  assert.match(older.results[0].messages[1], /^이전 이름: 처음\n/);
  assert.equal(store.previousEntry(ROOM, MEMBER, NOW, '100').eventId, '91');
  const sameSecond = await handle(event({ id: '92', at: NOW - 1_000, members: [{ userId: MEMBER, nickName: '같은 초 다음 입장' }] }));
  assert.match(sameSecond.results[0].messages[1], /^이전 이름: 최신\n/);
  assert.equal(store.previousEntry(ROOM, MEMBER, NOW, '100').eventId, '92');
});

test('a reentry after the 30-day send-log window still reports the last actual entry', async (t) => {
  const { handle, store } = setup(t);
  const oldAt = NOW - 40 * 86_400_000;
  store.prepareJoin(parseWelcomeEvent(event({ id: '80', at: oldAt })),
    [{ id: MEMBER, name: '오래전 입장 이름', latestName: '다른 관측 이름' }], 'simulated', ROOM_NAME);
  store.prune(NOW);
  assert.equal(store.hasEvent(ROOM, '80'), false);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM welcome_messages').get().count, 0);
  const result = await handle(event());
  assert.deepEqual(result.results[0].messages, ['화사한 뇽냥/95님 "포근은행"에 어서오세요!\n즐거운 길드 생활 되세요!',
    formatPreviousEntry({ name: '오래전 입장 이름', at: oldAt })]);
});

for (const remainingStatus of ['reserved', 'uncertain']) test(`restart preserves a ${remainingStatus} second message without resending the confirmed greeting`, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'opentalk-welcome-partial-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.sqlite');
  const store1 = new WelcomeStore(path);
  store1.baseline(BOT, [ROOM], NOW - 30_000);
  const members = [{ id: MEMBER, name: '입장 이름', latestName: '프로필 이름' }];
  store1.prepareJoin(parseWelcomeEvent(event({ id: '90', at: NOW - 2_000 })), members, 'simulated', ROOM_NAME);
  store1.prepareJoin(parseWelcomeEvent(event()), members, 'reserved', ROOM_NAME);
  store1.finishMessage(ROOM, '100', 0, 'confirmed_in_iris');
  if (remainingStatus === 'uncertain') store1.finishMessage(ROOM, '100', 1, 'uncertain');
  store1.close();
  const store2 = new WelcomeStore(path);
  let sent = 0;
  try {
    const handle = createWelcomeHandler({ store: store2, rooms: [ROOM], botId: BOT, send: true,
      now: () => NOW, startedAt: NOW - 30_000,
      iris: { async getBotId() { return BOT; }, async reply() { sent++; } } });
    assert.equal((await handle(event())).status, 'duplicate');
    await assert.rejects(handle(event({ id: '101' })), /UNCONFIRMED_REPLY_REQUIRES_REVIEW/);
    assert.equal(sent, 0);
    assert.deepEqual(store2.db.prepare('SELECT status FROM welcome_messages WHERE event_id=? ORDER BY sequence').all('100')
      .map((row) => row.status), ['confirmed_in_iris', remainingStatus]);
    store2.prune(NOW + 31 * 86_400_000);
    assert.equal(store2.hasUnconfirmed(), true);
  } finally { store2.close(); }
});

test('durable reservation survives restart and excludes a second SQLite writer', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'opentalk-welcome-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.sqlite');
  const store1 = new WelcomeStore(path);
  store1.baseline(BOT, [ROOM], NOW);
  const joinEvent = parseWelcomeEvent(event());
  const members = [{ id: MEMBER, name: '이름', latestName: '이름' }];
  store1.prepareJoin(joinEvent, members, 'reserved', ROOM_NAME);
  store1.close();
  const store2 = new WelcomeStore(path);
  try {
    assert.equal(store2.prepareJoin(joinEvent, members, 'reserved', ROOM_NAME), null);
    assert.throws(() => store2.prepareJoin({ ...joinEvent, eventId: '101' }, members, 'reserved', ROOM_NAME), /UNCONFIRMED_REPLY/);
  } finally { store2.close(); }
});

test('baseline/account mismatch fails closed', async (t) => {
  const store = new WelcomeStore(':memory:'); t.after(() => store.close());
  assert.throws(() => createWelcomeHandler({ store, iris: {}, rooms: [ROOM], botId: BOT }), /BASELINE/);
  store.baseline(BOT, [ROOM], NOW);
  assert.throws(() => store.baseline('501', [ROOM], NOW), /BASELINE/);
  const { handle, calls } = setup(t, { iris: { async getBotId() { return '501'; } } });
  await assert.rejects(handle(event()), /IRIS_ACCOUNT_CHANGED/);
  assert.equal(calls.names.length, 0);
});

test('30-day logs expire while the latest real entry and unresolved-send guard persist', (t) => {
  const { store } = setup(t);
  const at = NOW - 31 * 86_400_000;
  const old = parseWelcomeEvent(event({ at }));
  store.prepareJoin(old, [{ id: MEMBER, name: '옛 이름', latestName: '옛 이름' }], 'simulated', ROOM_NAME);
  store.prepareJoin({ ...old, eventId: '101' }, [{ id: MEMBER, name: '이름', latestName: '이름' }], 'reserved', ROOM_NAME);
  store.prune(NOW);
  assert.equal(store.hasEvent(ROOM, '100'), false);
  assert.equal(store.hasEvent(ROOM, '101'), true);
  assert.equal(store.hasUnconfirmed(), true);
  assert.equal(store.previousName(ROOM, MEMBER, '이름', NOW), '옛 이름');
  assert.deepEqual(store.previousEntry(ROOM, MEMBER, NOW, '200'), { name: '이름', at, eventId: '101' });
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM entries').get().count, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM welcome_messages WHERE event_id=?').get('100').count, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM welcome_messages WHERE event_id=?').get('101').count, 2);
});

test('invalid/ambiguous members, unsupported feed and control-character names fail', () => {
  assert.throws(() => parseWelcomeEvent(event({ members: [{ userId: MEMBER, nickName: 'A' }, { userId: MEMBER, nickName: 'B' }] })), /DUPLICATE_JOIN_MEMBER/);
  assert.throws(() => parseWelcomeEvent(event({ members: [{ userId: MEMBER, nickName: 'A\n가짜 이름' }] })), /INVALID_NICKNAME/);
  const e = event(); e.json.created_at = NOW;
  assert.throws(() => parseWelcomeEvent(e), /UNIX_SECONDS_REQUIRED/);
});

test('baseline seeds silent members once and never overwrites their observed history', () => {
  const store = new WelcomeStore(':memory:');
  try {
    const seed = { roomId: ROOM, memberId: MEMBER, name: '처음 이름' };
    store.baseline(BOT, [ROOM], NOW - 1_000, [seed]);
    store.baseline(BOT, [ROOM], NOW, [{ ...seed, name: '덮어쓰면 안 됨' }]);
    assert.equal(store.member(ROOM, MEMBER).name, '처음 이름');
    assert.equal(store.previousName(ROOM, MEMBER, '바뀐 이름', NOW), '처음 이름');
    assert.equal(store.previousEntry(ROOM, MEMBER, NOW, '100'), null);
  } finally { store.close(); }
  const invalid = new WelcomeStore(':memory:');
  try {
    assert.throws(() => invalid.baseline(BOT, [ROOM], NOW, [{ roomId: '2', memberId: MEMBER, name: '이름' }]), /INVALID_BASELINE_MEMBER/);
    assert.equal(invalid.initialized(), false);
  } finally { invalid.close(); }
});

test('latest profile observation uses actual lookup time, not the older message time', async (t) => {
  const { handle, store } = setup(t);
  await handle(event({ id: '90', actor: MEMBER, origin: 'MSG', at: NOW - 2_000 }));
  assert.equal(store.member(ROOM, MEMBER).observed_at, NOW);
  assert.equal(store.previousName(ROOM, MEMBER, '다른 이름', NOW - 1_000), null);
});
