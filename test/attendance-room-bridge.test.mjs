import { bridgeFixture, fixtureRoomIdentity, FIXTURE_ROOM_ID, createPhone } from './helpers/messengerbot-phone.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

// The transport tests cannot read or write live user state or send network requests.
globalThis.__roomBridgeWrites = 0;
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/src/json-store.js')) return {
      format: 'module', shortCircuit: true,
      source: `
        export class CorruptStoreError extends Error {}
        export const readJson = (path, fallback) => structuredClone(fallback);
        export const readJsonLenient = readJson;
        export const writeJsonAtomic = () => {
          globalThis.__roomBridgeWrites++;
          throw new Error('Unexpected state write');
        };
      `,
    };
    return nextLoad(url, context);
  },
});
globalThis.fetch = async () => { throw new Error('Unexpected network request'); };

const { parseAttendanceIdentity, parseRoomIdentity, KakaoInteraction } = await import('../src/kakao/interaction.js');
const { handleBridgeMessage } = await import('../src/kakao/handler.js');
const attendance = await import('../src/commands/attendance.js');
const attendanceStatus = await import('../src/commands/attendance-status.js');
const SOURCE = 'android-conversation-shortcut-v1';
const roomIdentity = (roomId = '1234567890123456789') => ({ source: SOURCE, roomId });
const personIdentity = (roomId = '1234567890123456789', userId = 'person-1') => ({
  source: 'android-person-key-v1', roomId, userId,
});
const BASE = 'https://example.invalid';

function commandMap(calls) {
  return new Map([
    ['출첵', { data: attendance.data, execute: attendance.createExecute({
      checkIn(userId, options) {
        calls.push({ type: 'checkIn', userId, options });
        return { status: 'checked', gained: 2, total: 18, count: 9 };
      },
    }) }],
    ['출석현황', { data: attendanceStatus.data, execute: attendanceStatus.createExecute({
      getStatus(roomName, options) {
        calls.push({ type: 'getStatus', roomName, options });
        return { members: [{ name: '검증회원', points: 18 }] };
      },
    }) }],
  ]);
}

function phone() {
  const device = createPhone({ answer: { text: '검증 응답', link: null } });
  return { context: device.context,
    get sent() { return device.requests.map(request => request.body); },
    get replies() { return device.attempts.map(attempt => attempt.text); },
    notify(options = {}) {
      device.notify({ room: '포근은행', sender: '검증회원', text: '/출첵', personKey: null, ...options });
      device.advance(60000);
    },
  };
}

test('room identities validate their source and opaque IDs independently of person keys', () => {
  for (const id of ['1', '  opaque room  ', '9'.repeat(512)]) {
    assert.deepEqual(parseRoomIdentity({ ...roomIdentity(id), extra: 'discard' }), roomIdentity(id));
  }
  for (const value of [null, undefined, [], 'room', {}, { roomId: '1' },
    { source: 'android-person-key-v1', roomId: '1' },
    ...['', ' ', '\t', 'a\nb', 'a\u0000b', 'a\u007fb', 'a\u0085b', '9'.repeat(513)].map(roomIdentity),
    roomIdentity(123)]) assert.equal(parseRoomIdentity(value), null);
  const target = new KakaoInteraction('oc:검증회원', {}, { roomName: '포', roomIdentity: roomIdentity() });
  assert.deepEqual(target.roomIdentity, roomIdentity());
  assert.equal(target.attendanceIdentity, null);
  assert.equal(target.user.id, 'kakao:oc:검증회원');
  assert.deepEqual(parseAttendanceIdentity(personIdentity('9'.repeat(512))), personIdentity('9'.repeat(512)));
});

test('verified Android conversations carry stable room IDs after renames without person keys', async (t) => {
  t.mock.method(console, 'log', () => {});
  const device = phone();
  device.notify();
  device.notify({ room: '포', text: '/출석현황' });
  assert.equal(device.sent.length, 2);
  assert.deepEqual(device.sent.map((body) => body.room), ['포근은행', '포']);
  assert.deepEqual(device.sent.map((body) => body.roomIdentity), [roomIdentity(), roomIdentity()]);
  assert.ok(device.sent.every((body) => body.attendanceIdentity === null));
  assert.equal(device.replies.length, 2);
  assert.ok(device.context.bridgeSessions.every((session) => session.blocked), 'automatic reply-session rename blocking remains unchanged');
  const calls = [];
  const map = commandMap(calls);
  for (const body of device.sent) await handleBridgeMessage(body, map, { allowedRoomIds: [FIXTURE_ROOM_ID], baseUrl: BASE });
  assert.deepEqual(calls.map((call) => call.type), ['checkIn', 'getStatus']);
  assert.equal(calls[0].userId, 'kakao:oc:검증회원');
  assert.equal(calls[0].options.roomName, '포근은행');
  assert.equal(calls[1].roomName, '포');
  assert.ok(calls.every((call) => call.options.identity === null));
  assert.ok(calls.every((call) => JSON.stringify(call.options.roomIdentity) === JSON.stringify(roomIdentity())));
});

test('person identities coexist with room identity while unidentified legacy callbacks stay silent', async (t) => {
  t.mock.method(console, 'log', () => {});
  const device = phone();
  device.notify({ personKey: 'person-1' });
  assert.deepEqual(device.sent[0].attendanceIdentity, personIdentity());
  assert.deepEqual(device.sent[0].roomIdentity, roomIdentity());
  const calls = [];
  await handleBridgeMessage(device.sent[0], commandMap(calls), { allowedRoomIds: [FIXTURE_ROOM_ID], baseUrl: BASE });
  assert.deepEqual(calls[0].options.identity, personIdentity());
  assert.deepEqual(calls[0].options.roomIdentity, roomIdentity());
  assert.equal(calls[0].userId, 'kakao:oc:검증회원');
  device.context.bridgeRawEnabled = false;
  device.context.response('레거시 방', 'ㅊㅊ', '검증회원', true, { reply() {} }, null, 'com.kakao.talk');
  assert.equal(device.sent.length, 1);
  const legacy = await handleBridgeMessage({ room: '레거시 방', sender: '검증회원', text: 'ㅊㅊ', attendanceIdentity: null },
    commandMap(calls), { allowedRoomIds: [FIXTURE_ROOM_ID], baseUrl: BASE });
  assert.deepEqual(legacy, { text: null, link: null });
  assert.equal(calls.length, 1);
});

test('unverified notification conversations are rejected before any server request', () => {
  const device = phone();
  device.notify({ rankingId: 'different-room' });
  device.notify({ rankingPackage: 'other.application' });
  device.notify({ roomId: '' });
  assert.equal(device.sent.length, 0);
  assert.equal(device.replies.length, 0);
});

test('the real handler rejects malformed room identities even when person identity is valid', async (t) => {
  t.mock.method(console, 'log', () => {});
  const calls = [];
  const map = commandMap(calls);
  for (const invalid of [{ source: 'unknown', roomId: '1' }, roomIdentity('x\ny'), roomIdentity('9'.repeat(513))]) {
    await handleBridgeMessage({ isGroupChat: true, room: '포', sender: '검증회원', text: '/출석현황',
      roomIdentity: invalid, attendanceIdentity: personIdentity() }, map, { allowedRoomIds: [FIXTURE_ROOM_ID], baseUrl: BASE });
  }
  assert.equal(calls.length, 0);
});

test('pending cache separates same-named rooms but shares retries in the same stable room', async (t) => {
  t.mock.method(console, 'log', () => {});
  const calls = [];
  const map = new Map([['출석현황', { data: attendanceStatus.data, async execute(interaction) {
    const id = interaction.roomIdentity.roomId;
    calls.push(id);
    await delay(20);
    await interaction.reply(`방 ${id} 현황`);
  } }]]);
  const body = (id) => ({ isGroupChat: true, room: '동일한 방 이름', sender: '동명이인', text: '/출석현황', roomIdentity: roomIdentity(id) });
  const first = body('room-a');
  const results = await Promise.all([first, body('room-b'), first].map((request) =>
    handleBridgeMessage(request, map, { allowedRoomIds: ['room-a', 'room-b'], baseUrl: BASE, budgetMs: 1000 })));
  assert.deepEqual(calls, ['room-a', 'room-b']);
  assert.deepEqual(results.map((result) => result.text), ['방 room-a 현황', '방 room-b 현황', '방 room-a 현황']);
  assert.equal(globalThis.__roomBridgeWrites, 0);
});

test('both attendance commands distinguish missing room identity from v3 user identity', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  for (const code of ['ROOM_IDENTITY_REQUIRED', 'IDENTITY_REQUIRED']) {
    const fail = () => { throw Object.assign(new Error('fixture identity failure'), { code }); };
    const map = new Map([
      ['출첵', { data: attendance.data, execute: attendance.createExecute({ checkIn: fail }) }],
      ['출석현황', { data: attendanceStatus.data, execute: attendanceStatus.createExecute({ getStatus: fail }) }],
    ]);
    for (const name of ['출첵', '출석현황']) {
      const result = await handleBridgeMessage(bridgeFixture({ room: '포', sender: '검증회원', text: `/${name}` }), map, { allowedRoomIds: [FIXTURE_ROOM_ID], baseUrl: BASE });
      const expected = code === 'ROOM_IDENTITY_REQUIRED' ? attendance.ROOM_IDENTITY_REQUIRED
        : name === '출첵' ? attendance.IDENTITY_REQUIRED : attendanceStatus.IDENTITY_REQUIRED;
      assert.equal(result.text, expected);
    }
  }
  assert.equal(globalThis.__roomBridgeWrites, 0);
});

test('bare ㅊㅊㅎㅎ opens the attendance status while bare ㅊㅊ still checks in, on the server and on the phone', async (t) => {
  t.mock.method(console, 'log', () => {});
  const calls = [];
  const map = commandMap(calls);
  const send = (text) => handleBridgeMessage(bridgeFixture({ room: '포', sender: '검증회원', text, roomIdentity: roomIdentity() }), map, { allowedRoomIds: [FIXTURE_ROOM_ID], baseUrl: BASE });
  for (const text of ['ㅊㅊㅎㅎ', 'ㅊㅊㅎㅎ 아무말', '.ㅊㅊㅎㅎ', '/출석현황']) {
    calls.length = 0;
    assert.match((await send(text)).text, /출석 현황표/u, text);
    assert.deepEqual(calls.map((call) => call.type), ['getStatus'], text);
  }
  calls.length = 0;
  assert.match((await send('ㅊㅊ')).text, /출석/u);
  assert.deepEqual(calls.map((call) => call.type), ['checkIn']);
  for (const text of ['ㅊㅊㅎ', 'ㅊㅊㅎㅎㅎ', '출석현황', 'ㅊㅊㅎㅎ아무말']) {
    calls.length = 0;
    assert.equal((await send(text)).text, null, text);
    assert.equal(calls.length, 0, text);
  }

  const source = readFileSync(new URL('../scripts/messengerbot-r.js', import.meta.url), 'utf8');
  const match = /var isBareAlias = (\/\^\\s\*\(\?:[^)]+\)\(\?:\\s\|\$\)\/)\.test\(msg\)/.exec(source);
  assert.ok(match, 'isBareAlias 정규식');
  const bare = new RegExp(match[1].slice(1, -1));
  for (const text of ['ㅊㅊㅎㅎ', 'ㅊㅊㅎㅎ 아무말', ' ㅊㅊㅎㅎ', 'ㅊㅊ', 'ㅊㅊ 오늘']) assert.ok(bare.test(text), text);
  for (const text of ['ㅊㅊㅎ', 'ㅊㅊㅎㅎㅎ', 'ㅊㅊㅎㅎ아무말', '출석현황', '아 ㅊㅊㅎㅎ']) assert.ok(!bare.test(text), text);
  const device = phone();
  device.notify({ text: 'ㅊㅊㅎㅎ' });
  device.notify({ text: 'ㅊㅊㅎ' });
  assert.deepEqual(device.sent.map((request) => request.text), ['ㅊㅊㅎㅎ']);
});
