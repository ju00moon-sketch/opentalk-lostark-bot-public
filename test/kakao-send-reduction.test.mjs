import test from 'node:test';
import assert from 'node:assert/strict';
import { handleBridgeMessage } from '../src/kakao/handler.js';
import { resultCount } from '../src/kakao/result-store.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startKakaoServer } from '../src/kakao/server.js';
import { listenOnFreePort } from './helpers/free-port.mjs';
import { DEFAULT_DELIVERY_POLICY } from '../src/kakao/bridge-policy.js';
import { createPhone, bridgeFixture, fixtureRoomIdentity, FIXTURE_ROOM_ID } from './helpers/messengerbot-phone.mjs';

const BASE = 'https://example.invalid';
const options = { baseUrl: BASE, allowedRoomIds: [FIXTURE_ROOM_ID] };
const mapFor = (payloads, calls = []) => new Map([['fixture', {
  data: { name: 'fixture', toJSON: () => ({ name: 'fixture', options: [] }) },
  async execute(i) { calls.push(i); for (const p of payloads) await i.followUp(p); },
}]]);
const messages = answer => [answer.link, ...(Array.isArray(answer.messages) && answer.messages.length ? answer.messages : [answer.text])].filter(Boolean);

test('the bridge refuses unconsented groups, private chats and missing or invalid identity before command execution', async () => {
  const calls = [];
  const map = mapFor(['fixture'], calls);
  for (const body of [
    bridgeFixture({ isGroupChat: false }), bridgeFixture({ isGroupChat: 'true' }), bridgeFixture({ isGroupChat: undefined }),
    bridgeFixture({ roomIdentity: undefined }), bridgeFixture({ roomIdentity: fixtureRoomIdentity('outside') }),
    bridgeFixture({ roomIdentity: fixtureRoomIdentity(123) }),
    bridgeFixture({ roomIdentity: { source: 'unknown', roomId: FIXTURE_ROOM_ID } }),
  ]) assert.deepEqual(await handleBridgeMessage(body, map, options), { text: null, link: null });
  assert.equal(calls.length, 0);
  for (const allowedRoomIds of [undefined, [], ['outside'], [FIXTURE_ROOM_ID, 123], 'not-an-array']) {
    assert.deepEqual(await handleBridgeMessage(bridgeFixture(), map, { baseUrl: BASE, allowedRoomIds }), { text: null, link: null });
  }
  assert.equal(calls.length, 0);
});

test('an allowed opaque room identity survives a display-name change and retains command behaviour', async () => {
  const calls = [];
  const result = await handleBridgeMessage(bridgeFixture({ room: '새 표시 이름' }), mapFor(['fixture'], calls), options);
  assert.equal(result.text, 'fixture');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].roomIdentity.roomId, FIXTURE_ROOM_ID);
});

test('refused slash typos and command errors stay silent on the bridge', async () => {
  const map = mapFor(['fixture']);
  for (const text of ['/unknown-command', '.fixture']) {
    assert.deepEqual(await handleBridgeMessage(bridgeFixture({ text, isGroupChat: false }), map, options), { text: null, link: null });
  }
});

test('a short card and multiple bodies fit by merging only when the send count requires it', async () => {
  const short = await handleBridgeMessage(bridgeFixture(), mapFor([{ content: 'summary', characterCard: 'fixture' }]), options);
  assert.equal(messages(short).length, 2);
  const large = await handleBridgeMessage(bridgeFixture(), mapFor([
    { content: 'summary', characterCard: 'fixture' }, { content: 'equipment', kakaoSeparateMessage: true },
  ]), options);
  assert.equal(large.link, short.link);
  assert.equal(large.text, 'summary\n\nequipment');
  assert.equal('messages' in large, false);
  assert.equal(messages(large).length, 2);
  const phone = createPhone({ answer: large });
  phone.notify();
  assert.deepEqual(phone.attempts.map(a => a.text), [large.link, 'summary\n\nequipment']);
});

test('joined body separators count toward the limit and overflow ends at a complete line without publication', async () => {
  const before = resultCount();
  const answer = await handleBridgeMessage(bridgeFixture(), mapFor([
    { content: 'a'.repeat(866) }, { content: 'b'.repeat(866), kakaoSeparateMessage: true },
    { content: 'c'.repeat(866), kakaoSeparateMessage: true },
  ]), options);
  assert.equal(answer.text, 'a'.repeat(866) + '\n\n' + 'b'.repeat(866) + '…');
  assert.equal(resultCount(), before);
});

test('the 2600-character boundary keeps folding text and truncates excess body without publishing it', async () => {
  const before = resultCount();
  const inline = 'x'.repeat(2600) + '\u200b'.repeat(500);
  const exact = await handleBridgeMessage(bridgeFixture(), mapFor([{ content: 'preview', kakaoBridgeText: inline }]), options);
  assert.equal(messages(exact).join(''), inline);
  const device = createPhone({ answer: exact });
  device.notify();
  assert.deepEqual(device.attempts.map(attempt => attempt.text), [inline]);
  const overflow = await handleBridgeMessage(bridgeFixture(), mapFor([{ content: 'preview', kakaoBridgeText: 'x'.repeat(2601) }]), options);
  assert.equal(overflow.text, 'x'.repeat(2599) + '…');
  const aggregate = await handleBridgeMessage(bridgeFixture(), mapFor([
    { content: 'a'.repeat(1400) }, { content: 'b'.repeat(1400), kakaoSeparateMessage: true },
  ]), options);
  assert.equal(aggregate.text, 'a'.repeat(1400) + '…');
  assert.equal(resultCount(), before);
});

test('the phone does not call HTTP or reply in a private, unlisted or unidentified room, even on server errors', () => {
  const phone = createPhone();
  phone.setHttpError(new Error('fixture network failure'));
  for (const settings of [{ group: false }, { missingGroup: true }, { roomId: 'outside' }, { roomId: '' }, { rankingId: 'different' }]) {
    phone.notify({ text: '/unknown-command', ...settings });
  }
  assert.equal(phone.requests.length, 0);
  assert.equal(phone.attempts.length, 0);
});

test('the phone adds the actual group flag to a permitted bridge request', () => {
  const phone = createPhone();
  phone.notify();
  assert.equal(phone.requests.length, 1);
  assert.equal(phone.requests[0].body.isGroupChat, true);
  assert.equal(phone.requests[0].body.roomIdentity.roomId, FIXTURE_ROOM_ID);
  assert.equal(phone.attempts.length, 1);
});

test('the phone drops an old response when its room is removed while HTTP is pending', () => {
  const phone = createPhone();
  phone.setBeforeReturn(() => { phone.context.ALLOWED_ROOM_IDS = []; });
  phone.notify();
  assert.equal(phone.requests.length, 1);
  assert.equal(phone.attempts.length, 0);
});

test('the last phone boundary rejects excess sends and aggregate length rather than splitting them', () => {
  for (const answer of [{ link: 'https://example.invalid/card', messages: ['first', 'second'] },
    { text: 'x'.repeat(2601) }, { messages: ['x'.repeat(1400), 'y'.repeat(1400)] }]) {
    const phone = createPhone({ answer });
    phone.notify();
    assert.equal(phone.attempts.length, 0);
  }
});

test('a failed first or second send never produces a retry or an extra error message', () => {
  for (const failAt of [1, 2]) {
    const phone = createPhone({ answer: { link: 'https://example.invalid/card', text: 'body' } });
    phone.setReplyError(n => n === failAt);
    phone.notify({ eventId: 'same-event' });
    phone.advance(16000);
    phone.notify({ eventId: 'same-event' });
    assert.equal(phone.attempts.length, failAt);
  }
});

test('an attempted event is not sent again after a fresh script instance', () => {
  const phone = createPhone();
  phone.notify({ eventId: 'persistent-event' });
  assert.equal(phone.attempts.length, 1);
  const next = createPhone({ store: phone.store, now: phone.time() + 20000 });
  next.notify({ eventId: 'persistent-event' });
  assert.equal(next.attempts.length, 0);
});

test('persistent storage failure stops sends before the Android reply call', () => {
  const phone = createPhone();
  phone.setStoreFailure(true);
  phone.notify();
  assert.equal(phone.attempts.length, 0);
});

test('an interruption after durable recording and before reply omits the answer without resending after restart', () => {
  const phone = createPhone();
  phone.setAfterCommit(() => { throw new Error('Interrupted after storage commit'); });
  phone.notify({ eventId: 'interrupted' });
  assert.equal(phone.attempts.length, 0);
  assert.equal(JSON.parse(phone.store.get('pogeun-delivery/state')).events.length, 1);
  const next = createPhone({ store: phone.store, now: phone.time() + 60000 });
  next.notify({ eventId: 'interrupted' });
  assert.equal(next.attempts.length, 0);
  assert.equal(next.requests.length, 0);
});

test('a running bridge reloads a private policy file and fails closed on invalid settings', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'opentalk-delivery-policy-'));
  const policyPath = join(dir, 'policy.json');
  const write = value => writeFileSync(policyPath, JSON.stringify(value));
  write({ allowedRoomIds: [], delivery: { requestChars: 5 } });
  const { server } = await listenOnFreePort(port => startKakaoServer(mapFor(['123456']), {
    KAKAO_PORT: String(port), KAKAO_SKILL_SECRET: 'fixture', PUBLIC_BASE_URL: BASE,
    KAKAO_BRIDGE_ALLOWED_ROOM_IDS: JSON.stringify([FIXTURE_ROOM_ID]), KAKAO_BRIDGE_POLICY_FILE: policyPath,
  }));
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(dir, { recursive: true, force: true }); });
  const request = async () => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/bridge/message/fixture`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bridgeFixture()),
    });
    assert.equal(res.status, 200);
    return res.json();
  };
  assert.equal((await request()).text, null);
  write({ allowedRoomIds: [FIXTURE_ROOM_ID], delivery: { requestChars: 100 } });
  const accepted = await request();
  assert.equal(accepted.text, '123456');
  assert.equal(accepted.deliveryPolicy.requestChars, 100);
  write({ allowedRoomIds: [FIXTURE_ROOM_ID], delivery: { requestChars: 'invalid' } });
  assert.equal((await request()).text, null);
  writeFileSync(policyPath, '{bad');
  assert.equal((await request()).text, null);
  write({ allowedRoomIds: null });
  assert.equal((await request()).text, null);
});

test('a permitted two-message response preserves folding markers while counting only readable characters', () => {
  const text = 'x'.repeat(1900) + '\u200b'.repeat(500);
  const phone = createPhone({ answer: { link: 'https://example.invalid/card', text } });
  phone.notify();
  assert.deepEqual(phone.attempts.map(a => a.text), ['https://example.invalid/card', text]);
});

test('room and user gaps plus repeated arguments yield at most one notice in the window', () => {
  const phone = createPhone();
  phone.notify({ text: '.fixture 4000' });
  phone.advance(1000); phone.notify({ text: '.fixture 4000' });
  assert.equal(phone.attempts.length, 1, 'room gap leaves no space for a notice');
  phone.advance(1500); phone.notify({ text: '.fixture 4000' });
  assert.equal(phone.attempts.length, 2);
  assert.equal(phone.attempts[1].text, '답이 한꺼번에 너무 많이 나가서 잠시 쉬어 갈게요. 조금 뒤에 다시 불러 주세요.');
  phone.advance(4000); phone.notify({ text: '.fixture 4000' });
  phone.advance(4000); phone.notify({ text: '.fixture 4000' });
  assert.equal(phone.attempts.length, 2);
  phone.advance(5000); phone.notify({ text: '.fixture 8800' });
  assert.equal(phone.attempts.length, 3, 'a different argument can be requested without waiting for the old argument');
});

test('the user message budget counts cards and bodies and survives a script restart', () => {
  const answer = { link: 'https://example.invalid/card', text: 'body' };
  const phone = createPhone({ answer });
  phone.notify({ text: '.fixture 1', eventId: 'budget-1' });
  phone.advance(3000); phone.notify({ text: '.fixture 2', eventId: 'budget-2' });
  assert.equal(phone.attempts.length, 4);
  const next = createPhone({ store: phone.store, answer, now: phone.time() + 3000 });
  next.notify({ text: '.fixture 3', eventId: 'budget-3' });
  next.advance(3000); next.notify({ text: '.fixture 4', eventId: 'budget-4' });
  assert.equal(next.attempts.length, 2, 'six total attempts exhaust this user, including any notice');
  next.advance(60000); next.notify({ text: '.fixture 5', eventId: 'budget-5' });
  assert.equal(next.attempts.length, 4);
});

test('the room message budget is shared by different users', () => {
  const phone = createPhone({ answer: { link: 'https://example.invalid/card', text: 'body' } });
  for (let i = 0; i < 7; i++) {
    phone.notify({ sender: `user-${i}`, personKey: `person-${i}`, text: `.fixture ${i}` });
    phone.advance(2000);
  }
  assert.equal(phone.attempts.length, 12);
});

test('room and user readable-character windows block further messages without extra notices', () => {
  const user = createPhone({ answer: { text: 'x'.repeat(1500) } });
  for (let i = 0; i < 4; i++) { user.notify({ text: `.fixture ${i}` }); user.advance(3000); }
  assert.equal(user.attempts.length, 3);
  const room = createPhone({ answer: { text: 'x'.repeat(1500) } });
  for (let i = 0; i < 7; i++) {
    room.notify({ sender: `user-${i}`, personKey: `person-${i}`, text: `.fixture ${i}` }); room.advance(2000);
  }
  assert.equal(room.attempts.length, 6);
});

test('missing person keys share a room bucket instead of gaining fresh budgets through nicknames', () => {
  const phone = createPhone();
  phone.notify({ personKey: null, sender: 'first name' });
  phone.advance(4000); phone.notify({ personKey: null, sender: 'second name' });
  phone.advance(4000); phone.notify({ personKey: null, sender: 'third name' });
  assert.equal(phone.attempts.filter(a => a.text === 'fixture answer').length, 1);
  assert.ok(phone.attempts.length <= 2);
});

test('a response policy is validated and applied before its own output is sent', () => {
  const phone = createPhone({ answer: { text: 'x'.repeat(101), deliveryPolicy: { ...DEFAULT_DELIVERY_POLICY, requestChars: 100 } } });
  phone.notify();
  assert.equal(phone.attempts.length, 0);
  const invalid = createPhone({ answer: { text: 'fixture', deliveryPolicy: { ...DEFAULT_DELIVERY_POLICY, requestChars: 'invalid' } } });
  invalid.notify();
  assert.equal(invalid.attempts.length, 0);
});

test('a notification event remains the same while a display nickname changes during pending HTTP', () => {
  const phone = createPhone();
  let nested = false;
  phone.setBeforeReturn(() => {
    if (!nested) { nested = true; phone.notify({ eventId: 'concurrent', sender: 'new display name' }); }
  });
  phone.notify({ eventId: 'concurrent' });
  assert.equal(phone.requests.length, 1);
  assert.equal(phone.attempts.length, 1);
});

test('a full attempt journal does not evict valid records to permit a new send', () => {
  const phone = createPhone({ policy: { attemptLimit: 2 } });
  phone.notify({ eventId: 'first', text: '.fixture 1' });
  phone.advance(16000); phone.notify({ eventId: 'second', text: '.fixture 2' });
  phone.advance(16000); phone.notify({ eventId: 'third', text: '.fixture 3' });
  assert.equal(phone.attempts.length, 2);
  const next = createPhone({ store: phone.store, now: phone.time() + 16000, policy: { attemptLimit: 2 } });
  next.notify({ eventId: 'first', text: '.fixture 1' });
  assert.equal(next.attempts.length, 0);
});

test('clock rollback preserves both duplicate history and recent response budgets', () => {
  const phone = createPhone();
  phone.notify({ eventId: 'first', text: '.fixture 1' });
  const next = createPhone({ store: phone.store, now: phone.time() - 10000 });
  next.notify({ eventId: 'first', text: '.fixture 1' });
  next.notify({ eventId: 'second', text: '.fixture 2' });
  assert.equal(next.attempts.length, 0);
});

test('the persistent attempt journal contains hashes and counters instead of chat contents', () => {
  const phone = createPhone();
  phone.notify({ text: '.fixture PRIVATE-BODY', sender: 'PRIVATE-NAME' });
  assert.ok(phone.store.size > 0);
  for (const value of phone.store.values()) {
    assert.equal(value.includes('PRIVATE-BODY'), false);
    assert.equal(value.includes('PRIVATE-NAME'), false);
    assert.equal(value.includes('/bridge/message/'), false);
  }
});

test('a corrupted journal with coercible hashes or extra stored fields blocks new sends', () => {
  const original = createPhone();
  original.notify({ eventId: 'original' });
  for (const mutate of [event => { event.id = [event.id]; }, event => { event.chatText = 'unexpected stored data'; }]) {
    const state = JSON.parse(original.store.get('pogeun-delivery/state'));
    mutate(state.events[0]);
    const store = new Map([['pogeun-delivery/state', JSON.stringify(state)]]);
    const phone = createPhone({ store, now: original.time() + 60000 });
    phone.notify({ eventId: 'new' });
    assert.equal(phone.attempts.length, 0);
    assert.equal(phone.requests.length, 0);
  }
});

test('a renamed allowed conversation keeps interactive replies and the existing automatic-session block', () => {
  const phone = createPhone();
  phone.notify({ room: 'old title' });
  phone.advance(60000);
  phone.notify({ room: 'new title' });
  assert.equal(phone.attempts.length, 2);
  assert.ok(phone.context.bridgeSessions.every(session => session.blocked));
});

test('a journal entry expires at its stored deadline without evicting other valid attempts', () => {
  const phone = createPhone({ policy: { attemptLimit: 1 } });
  phone.notify({ eventId: 'first' });
  const next = createPhone({ store: phone.store, now: phone.time() + 86400000, policy: { attemptLimit: 1 } });
  next.notify({ eventId: 'second' });
  assert.equal(next.attempts.length, 1);
  assert.equal(JSON.parse(next.store.get('pogeun-delivery/state')).events.length, 1);
});

test('automatic notices are off by default and ordinary chat cannot start their timer', () => {
  const phone = createPhone({ autoUpdates: null });
  phone.notify({ text: 'ordinary conversation' });
  assert.equal(phone.timers.length, 0);
  assert.equal(phone.requests.length, 0);
  assert.equal(phone.attempts.length, 0);
});

test('opt-in automatic notices share the room budget and consume failed attempts without retrying', () => {
  const phone = createPhone({ autoUpdates: true });
  phone.setFeed({ version: 1, ready: true, cursor: 5,
    events: Array.from({ length: 5 }, (_, i) => ({ id: i + 1, text: 'x'.repeat(700), expiresAt: phone.time() + 3600000 })) });
  phone.notify({ text: 'ordinary conversation' });
  assert.equal(phone.attempts.length, 1, 'other batches wait instead of being sent in a burst');
  phone.advance(60000); phone.context.pollUpdates();
  assert.equal(phone.attempts.length, 2);
  phone.setReplyError(() => true);
  const successLogs = phone.logs.filter(line => line.includes('공지 발송')).length;
  phone.advance(60000); phone.context.pollUpdates();
  assert.equal(phone.attempts.length, 3);
  assert.equal(phone.logs.filter(line => line.includes('공지 발송')).length, successLogs, 'failed calls are not logged as successful sends');
  phone.advance(60000); phone.context.pollUpdates();
  assert.equal(phone.attempts.length, 3, 'the failed last batch is not sent again');
  const next = createPhone({ store: phone.store, now: phone.time() + 60000, autoUpdates: true });
  next.setFeed({ version: 1, ready: true, cursor: 6, events: [
    { id: 5, text: 'old failed event', expiresAt: next.time() + 60000 },
    { id: 6, text: 'new event', expiresAt: next.time() + 60000 },
  ] });
  next.notify({ text: 'ordinary conversation' });
  assert.equal(next.attempts.length, 1);
  assert.ok(next.attempts[0].text.includes('new event'));
  assert.equal(next.attempts[0].text.includes('old failed event'), false, 'failed events are not regrouped after restart');
});
