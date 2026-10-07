import test from 'node:test';
import assert from 'node:assert/strict';
import { createWelcomeLoco } from '../src/kakao/welcome-loco.js';
import { createWelcomeHandler, parseWelcomeEvent } from '../src/kakao/welcome.js';
import { WelcomeStore } from '../src/kakao/welcome-store.js';

const ROOM = '123456789012345678';
const ROOM_NAME = '포근은행';
const MEMBER = '111110000000000001';
const BOT = '500';
const LOG = '111110000000000002';
const NOW = Date.parse('2026-09-15T02:00:00Z');
class Long {
  constructor(value) { this.value = BigInt(value); }
  toString() { return String(this.value); }
  static isLong(value) { return value instanceof Long; }
  static fromString(value) { return new Long(value); }
}
const long = (value) => Long.fromString(value);
function packet({ room = ROOM, log = LOG, member = MEMBER, name = '새 이름', method = 'NEWMEM' } = {}) {
  return { chatLog: { chatId: long(room), logId: long(log), authorId: long('700'),
    sendAt: NOW / 1000, type: method === 'NEWMEM' ? 0 : 1,
    message: method === 'NEWMEM' ? `{"feedType":4,"members":[{"userId":${member},"nickName":"${name}"}]}`
      : 'PRIVATE_MESSAGE_BODY',
  } };
}
function setup(options = {}) {
  const calls = { names: [], roomNames: [], links: [], sends: [], requests: [], original: [] };
  let clock = NOW;
  const channel = {
    title: ROOM_NAME, linkName: '오픈링크 방 이름',
    channelId: long(ROOM), linkId: long('400'), clientUser: { userId: long(BOT) },
    async getLatestChannelInfo() { calls.roomNames.push(ROOM); return { success: true, status: 0,
      result: { channelId: long(ROOM), linkId: long('400'), metaMap: { 3: { content: channel.title } } } }; },
    async getLatestOpenLink() { calls.links.push('400'); return { success: true, status: 0,
      result: { linkId: long('400'), linkName: channel.linkName } }; },
    async getLatestUserInfo({ userId }) {
      calls.names.push(userId.toString());
      return { success: true, status: 0, result: [{ userId, nickname: '조회한 이름' }] };
    },
    async getAllLatestUserInfo() { return { success: true, status: 0,
      result: [{ userId: long(BOT), nickname: '봇' }, { userId: long(MEMBER), nickname: '기존 이름' }] }; },
    async sendChat(text, noSeen) {
      calls.sends.push({ text, noSeen });
      return { success: true, status: 0, result: { logId: long(LOG) } };
    },
  };
  const client = {
    logon: true, clientUser: { userId: long(BOT) },
    channelList: { open: { get(roomId) { return roomId.toString() === ROOM ? channel : undefined; } } },
    async pushReceived(...args) { calls.original.push(args); },
    async request(method, data) {
      calls.requests.push({ method, data });
      return { status: 0, chatLogs: [{ chatId: long(ROOM), logId: long(LOG), authorId: long(BOT),
        type: 1, message: calls.sends.at(-1)?.text }] };
    },
  };
  const adapter = createWelcomeLoco({ client, Long, rooms: [ROOM], botId: BOT, now: () => clock,
    pause: async (ms) => { clock += ms; }, confirmTimeoutMs: 1000, ...options });
  return { adapter, client, channel, calls };
}

test('module and constructor do not connect or send; default reply is disabled', async () => {
  const { adapter, calls } = setup();
  assert.deepEqual(calls.requests, []);
  await assert.rejects(adapter.reply(ROOM, '안녕하세요', BOT), /LOCO_RECEIVE_ONLY/);
  assert.deepEqual(calls.sends, []);
});

test('raw NEWMEM preserves 64-bit member/log IDs and uses feed member instead of author', async () => {
  const { adapter, client } = setup();
  const received = [];
  await adapter.start((envelope) => received.push(parseWelcomeEvent(envelope)), assert.fail);
  await client.pushReceived('NEWMEM', packet(), {});
  await adapter.stop();
  assert.equal(received[0].eventId, LOG);
  assert.deepEqual(received[0].members, [{ id: MEMBER, name: '새 이름' }]);
});

test('raw reception bypasses the unbounded high-level MEMBER handler for successive joins', async () => {
  const { adapter, client } = setup();
  let originalCalls = 0;
  client.pushReceived = () => { originalCalls++; return new Promise(() => {}); };
  const received = [];
  await adapter.start((envelope) => received.push(envelope), assert.fail);
  await client.pushReceived('NEWMEM', packet(), {});
  await client.pushReceived('NEWMEM', packet({ log: String(BigInt(LOG) + 1n) }), {});
  await adapter.stop();
  assert.equal(received.length, 2);
  assert.equal(originalCalls, 0);
});

test('system authored joins do not require an author ID', async () => {
  const { adapter, client } = setup();
  const received = [];
  const data = packet(); delete data.chatLog.authorId;
  await adapter.start((envelope) => received.push(envelope), assert.fail);
  await client.pushReceived('NEWMEM', data, {});
  await adapter.stop();
  assert.equal(received.length, 1);
});

test('unrelated rooms and methods do not reach welcome processing', async () => {
  const { adapter, client } = setup();
  const received = [];
  await adapter.start((envelope) => received.push(envelope), assert.fail);
  await client.pushReceived('NEWMEM', packet({ room: '999' }), {});
  await client.pushReceived('FEED', packet(), {});
  await adapter.stop();
  assert.equal(received.length, 0);
});

test('rounded IDs, mismatched room envelopes, and non-join feeds are rejected', async () => {
  const { adapter, client } = setup();
  const errors = [];
  await adapter.start(assert.fail, (error) => errors.push(error.code));
  const rounded = packet(); rounded.chatLog.logId = Number(LOG);
  await client.pushReceived('NEWMEM', rounded, {});
  const mismatch = packet(); mismatch.chatId = long('999');
  await client.pushReceived('NEWMEM', mismatch, {});
  const invalidFeed = packet(); invalidFeed.chatLog.message = '{"feedType":1,"members":[]}';
  await client.pushReceived('NEWMEM', invalidFeed, {});
  await adapter.stop();
  assert.deepEqual(errors, ['INVALID_ID', 'LOCO_ROOM_MISMATCH', 'OPEN_JOIN_FEED_REQUIRED']);
});

test('ordinary messages neither reach welcome processing nor the high-level message handler', async () => {
  const { adapter, client, calls } = setup();
  const received = [];
  await adapter.start((envelope) => received.push(envelope), assert.fail);
  await client.pushReceived('MSG', packet({ method: 'MSG' }), {});
  await adapter.stop();
  assert.deepEqual(received, []);
  assert.deepEqual(calls.original, []);
});

test('disconnect, server switch and membership-control packets keep their original handlers', async () => {
  const { adapter, client, calls } = setup();
  await adapter.start(assert.fail, assert.fail);
  for (const method of ['KICKOUT', 'CHANGESVR', 'DELMEM', 'LEFT']) await client.pushReceived(method, {}, {});
  await adapter.stop();
  assert.deepEqual(calls.original.map(([method]) => method), ['KICKOUT', 'CHANGESVR', 'DELMEM', 'LEFT']);
});

test('room validation requires matching server room/link IDs and actual bot membership', async () => {
  const { adapter, channel } = setup();
  channel.getLatestChannelInfo = async () => ({ success: true, status: 0,
    result: { channelId: long('999'), linkId: long('400') } });
  await assert.rejects(adapter.verifyRoom(ROOM), /LOCO_ROOM_MISMATCH/);
  await assert.rejects(adapter.verifyRoom('999'), /LOCO_ROOM_NOT_ALLOWED/);
});

test('room validation compares the link before the library updates its cache', async () => {
  const { adapter, channel } = setup();
  channel.getLatestChannelInfo = async () => {
    channel.linkId = long('401');
    return { success: true, status: 0, result: { channelId: long(ROOM), linkId: channel.linkId } };
  };
  await assert.rejects(adapter.verifyRoom(ROOM), /LOCO_ROOM_MISMATCH/);
});

test('room names come from fresh TITLE metadata and reflect subsequent renames', async () => {
  const { adapter, channel, calls } = setup();
  channel.getDisplayName = () => { throw new Error('cached display name must not be used'); };
  channel.info = { name: '잘못된 name 속성', openLink: { linkName: '오래된 캐시 이름' } };
  assert.equal(await adapter.getRoomName(ROOM), ROOM_NAME);
  channel.title = '새 "길드" 톡방';
  assert.equal(await adapter.getRoomName(ROOM), '새 "길드" 톡방');
  assert.deepEqual(calls.roomNames, [ROOM, ROOM]);
  assert.deepEqual(calls.names, [BOT, BOT]);
  assert.deepEqual(calls.links, []);
});

test('absent TITLE metadata resolves a fresh matching open-link name without cache fallback', async () => {
  const { adapter, channel, calls } = setup();
  channel.title = undefined;
  channel.getDisplayName = () => '사용하면 안 되는 캐시 이름';
  assert.equal(await adapter.getRoomName(ROOM), '오픈링크 방 이름');
  channel.title = '';
  channel.linkName = '이름이 바뀐 오픈링크';
  assert.equal(await adapter.getRoomName(ROOM), '이름이 바뀐 오픈링크');
  assert.deepEqual(calls.links, ['400', '400']);
});

test('invalid TITLE or open-link names never become cached names or room IDs', async () => {
  for (const title of [null, 123, {}, ' ', '가짜\n톡방']) {
    const { adapter, channel, calls } = setup();
    channel.title = title;
    await assert.rejects(adapter.getRoomName(ROOM), /INVALID_ROOM_NAME/);
    assert.deepEqual(calls.links, []);
  }
  for (const name of [undefined, null, '', ' ']) {
    const { adapter, channel } = setup();
    channel.title = undefined; channel.linkName = name;
    await assert.rejects(adapter.getRoomName(ROOM), /INVALID_ROOM_NAME/);
  }
});

test('room-name lookup rejects a foreign fresh link even if the SDK updates its cache first', async () => {
  for (const mutateCache of [false, true]) {
    const { adapter, channel } = setup();
    channel.title = undefined;
    channel.getLatestOpenLink = async () => {
      if (mutateCache) channel.linkId = long('401');
      return { success: true, status: 0, result: { linkId: long('401'), linkName: '다른 방' } };
    };
    await assert.rejects(adapter.getRoomName(ROOM), /LOCO_ROOM_MISMATCH/);
  }
});

test('room-name lookup rejects changed channel identity or bot account while awaiting metadata', async () => {
  for (const change of ['channel', 'account']) {
    const { adapter, channel, client } = setup();
    const getInfo = channel.getLatestChannelInfo;
    channel.getLatestChannelInfo = async () => {
      const result = await getInfo();
      if (change === 'channel') client.channelList.open.get = () => ({ ...channel });
      else client.clientUser = { userId: long('501') };
      return result;
    };
    await assert.rejects(adapter.getRoomName(ROOM), /LOCO_ROOM_MISMATCH|LOCO_ACCOUNT_CHANGED/);
  }
});

test('room-name lookup retains room allowlisting and actual bot membership verification', async () => {
  const { adapter, channel, calls } = setup();
  await assert.rejects(adapter.getRoomName('999'), /LOCO_ROOM_NOT_ALLOWED/);
  assert.deepEqual(calls.roomNames, []);
  channel.getLatestUserInfo = async () => ({ success: true, status: 0, result: [] });
  await assert.rejects(adapter.getRoomName(ROOM), /LOCO_MEMBER_NOT_FOUND_OR_AMBIGUOUS/);
});

test('an unavailable fresh room name has a deadline and never uses cached display text', async () => {
  const { adapter, channel } = setup({ timeoutMs: 10 });
  channel.title = undefined;
  channel.getDisplayName = () => '오래된 이름';
  channel.getLatestOpenLink = () => new Promise(() => {});
  await assert.rejects(adapter.getRoomName(ROOM), /LOCO_ROOM_NAME_UNAVAILABLE/);
});

test('profile lookup has a deadline even if the library never resolves MEMBER', async () => {
  const { adapter, channel } = setup({ timeoutMs: 10 });
  channel.getLatestUserInfo = () => new Promise(() => {});
  await assert.rejects(adapter.getName(ROOM, MEMBER), /LOCO_MEMBER_UNAVAILABLE/);
});

test('changed account and logged-out sessions stop profile access and reception', async () => {
  const { adapter, client } = setup();
  const errors = [];
  await adapter.start(assert.fail, (error) => errors.push(error.code));
  client.clientUser = { userId: long('999') };
  await client.pushReceived('NEWMEM', packet(), {});
  await assert.rejects(adapter.getName(ROOM, MEMBER), /LOCO_ACCOUNT_CHANGED/);
  client.logon = false;
  await assert.rejects(adapter.getBotId(), /LOCO_NOT_LOGGED_IN/);
  await adapter.stop();
  assert.deepEqual(errors, ['LOCO_ACCOUNT_CHANGED']);
});

test('member lookup rejects a different or duplicate returned member', async () => {
  const { adapter, channel } = setup();
  channel.getLatestUserInfo = async () => ({ success: true, status: 0,
    result: [{ userId: long(BOT), nickname: '잘못된 회원' }] });
  await assert.rejects(adapter.getName(ROOM, MEMBER), /LOCO_MEMBER_NOT_FOUND_OR_AMBIGUOUS/);
});

test('baseline lists verified member IDs and rejects a list without the bot', async () => {
  const { adapter, channel } = setup();
  assert.deepEqual(await adapter.listMembers(ROOM), [
    { roomId: ROOM, memberId: BOT, name: '봇' }, { roomId: ROOM, memberId: MEMBER, name: '기존 이름' },
  ]);
  channel.getAllLatestUserInfo = async () => ({ success: true, status: 0,
    result: [{ userId: long(MEMBER), nickname: '이름' }] });
  await assert.rejects(adapter.listMembers(ROOM), /LOCO_ROOM_MEMBERS_INVALID/);
});

test('reply requires acknowledgement and fresh server evidence for exact room/log/bot/text', async () => {
  const { adapter, calls } = setup({ send: true });
  await adapter.reply(ROOM, '환영합니다', BOT);
  assert.deepEqual(calls.sends, [{ text: '환영합니다', noSeen: true }]);
  assert.equal(calls.requests[0].method, 'MCHATLOGS');
  assert.equal(calls.requests[0].data.chatIds[0].toString(), ROOM);
  assert.equal(calls.requests[0].data.sinces[0].toString(), String(BigInt(LOG) - 1n));
});

for (const field of ['chatId', 'logId', 'authorId', 'message', 'type']) {
  test(`reply remains uncertain when server log ${field} does not match`, async () => {
    const { adapter, client, calls } = setup({ send: true });
    client.request = async () => ({ status: 0, chatLogs: [{ chatId: long(ROOM), logId: long(LOG),
      authorId: long(BOT), message: '환영합니다', type: 1,
      [field]: field === 'message' ? '다른 내용' : field === 'type' ? 2 : long('999') }] });
    await assert.rejects(adapter.reply(ROOM, '환영합니다', BOT), /LOCO_REPLY_UNCONFIRMED/);
    assert.equal(calls.sends.length, 1);
  });
}

test('failed acknowledgement is not retried or replaced by a local cache entry', async () => {
  const { adapter, channel, calls } = setup({ send: true });
  channel.sendChat = async () => ({ success: false, status: -1 });
  await assert.rejects(adapter.reply(ROOM, '환영합니다', BOT), /LOCO_REPLY_NOT_ACKNOWLEDGED/);
  assert.equal(calls.requests.length, 0);
});

test('stop drains queued processing and restores the original receiver', async () => {
  const { adapter, client } = setup();
  const original = client.pushReceived;
  const events = [];
  await adapter.start(async (envelope) => { await Promise.resolve(); events.push(envelope); }, assert.fail);
  await client.pushReceived('NEWMEM', packet(), {});
  await adapter.stop();
  assert.equal(events.length, 1);
  assert.equal(client.pushReceived, original);
});

test('LOCO transport fixture reaches existing welcome store and deduplicates without sending', async (t) => {
  const { adapter, client, calls } = setup();
  const store = new WelcomeStore(':memory:');
  t.after(() => store.close());
  store.baseline(BOT, [ROOM], NOW - 30_000);
  const handle = createWelcomeHandler({ store, iris: adapter, rooms: [ROOM], botId: BOT,
    now: () => NOW, startedAt: NOW - 30_000 });
  const results = [];
  await adapter.start(async (envelope) => { results.push(await handle(envelope)); }, assert.fail);
  await client.pushReceived('NEWMEM', packet(), {});
  await client.pushReceived('NEWMEM', packet(), {});
  await adapter.stop();
  assert.equal(results[0].status, 'simulated');
  assert.deepEqual(results[0].results[0].messages, ['새 이름님 "포근은행"에 어서오세요!\n즐거운 길드 생활 되세요!']);
  assert.equal(results[1].status, 'duplicate');
  assert.equal(calls.sends.length, 0);
});
