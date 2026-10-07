import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhone, FIXTURE_ROOM_ID as ROOM } from './helpers/messengerbot-phone.mjs';
import { formatWelcome, formatPreviousEntry } from '../src/kakao/welcome.js';
import { createHash } from 'node:crypto';

const BOT = '111110000000000003';
const MEMBER = '111110000000000004';
const plain = value => JSON.parse(JSON.stringify(value));
function setup(options = {}) {
  const p = createPhone(options);
  p.context.WELCOME_ENABLED = true;
  p.context.WELCOME_SEND = true;
  p.context.WELCOME_BOT_ID = BOT;
  p.notify({ text: '일반 대화' }); // Cache the existing verified notification action; no command/reply.
  let snapshot = { version: 1, generation: 'fixture-run', at: p.time(), botId: BOT, rooms: [ROOM], events: [], outgoing: [] };
  p.context.welcomeReadSnapshot = () => plain(snapshot);
  p.context.welcomeConfirm = () => true; // Hardware boundary; sends still use the complete phone script.
  return Object.assign(p, {
    snapshot, poll: () => p.context.pollWelcome(),
    join(id = '101', name = '새 회원', roomId = ROOM, member = MEMBER) {
      snapshot.at = p.time(); snapshot.events = [{ roomId, eventId: id, at: p.time(), members: [{ id: member, name }] }];
      return this.poll();
    },
  });
}

test('welcome defaults are disabled and do not start a timer or change ordinary replies', () => {
  const p = createPhone();
  assert.equal(p.context.WELCOME_ENABLED, false);
  assert.equal(p.context.WELCOME_SEND, false);
  assert.equal(p.timers.length, 0);
  p.notify();
  assert.equal(p.attempts.length, 1);
});

test('first entry and same-name reentry use the existing greeting/previous entry contract', () => {
  const p = setup(); const first = p.time();
  p.join();
  assert.deepEqual(p.attempts.map(a => a.text), [formatWelcome('새 회원', '검증방')]);
  p.advance(20_000); p.join('102');
  assert.deepEqual(p.attempts.slice(1).map(a => a.text), [formatWelcome('새 회원', '검증방'), formatPreviousEntry({ name: '새 회원', at: first })]);
});

test('durable event dedup and latest entry survive a script restart', () => {
  const p = setup(); p.join();
  p.poll(); assert.equal(p.attempts.length, 1);
  const q = setup({ store: p.store, now: p.time() + 20_000 });
  q.join(); assert.equal(q.attempts.length, 0);
  q.advance(20_000); q.join('102', '바꾼 이름');
  assert.match(q.attempts[1].text, /이전 이름: 새 회원/);
  const raw = p.store.get('pogeun-welcome/state');
  assert.ok(!raw.includes(MEMBER) && !raw.includes(ROOM), 'stable identity is hashed in stored records');
});

test('only allowlisted current group sessions can send, even when room names match', () => {
  for (const mutate of [p => { p.snapshot.rooms = ['222']; }, p => { p.context.ALLOWED_ROOM_IDS = []; },
    p => { p.context.bridgeSessions = []; }, p => { p.context.bridgeSessions[0].group = false; },
    p => { p.context.bridgeSessions[0].id = '222'; }, p => { p.context.bridgeSessions[0].blocked = true; }]) {
    const p = setup(); mutate(p); p.join(); assert.equal(p.attempts.length, 0);
  }
  const p = setup(); p.join('101', '회원', '222'); assert.equal(p.attempts.length, 0);
});

test('self joins, unsafe numeric IDs and malformed members cannot send', () => {
  const samples = [BOT, 111110000000000004, '0', '-5'];
  for (const member of samples) { const p = setup(); p.join('101', '회원', ROOM, member); assert.equal(p.attempts.length, 0); }
  for (const name of ['', 'a\nb', 'x'.repeat(101)]) {
    const p = setup(); p.join('101', name); assert.equal(p.attempts.length, 0);
  }
});

test('observation records actual entries without sending and activation never replays them', () => {
  const p = setup(); p.context.WELCOME_SEND = false; p.join();
  assert.equal(p.attempts.length, 0);
  p.context.WELCOME_SEND = true; p.poll(); assert.equal(p.attempts.length, 0);
  p.advance(20_000); p.join('102'); assert.equal(p.attempts.length, 2);
});

test('snapshot age, account change, generation restart, and old/future events fail closed', () => {
  for (const mutate of [p => { p.snapshot.botId = '1'; }, p => { p.snapshot.at -= 11_000; },
    p => { p.snapshot.events[0].at -= 130_000; }, p => { p.snapshot.events[0].at += 6000; }]) {
    const p = setup(); p.context.WELCOME_SEND = false; p.join();
    p.snapshot.events[0].eventId = '102'; p.context.WELCOME_SEND = true; mutate(p); p.poll();
    assert.equal(p.attempts.length, 0);
  }
  const p = setup(); p.poll(); p.snapshot.generation = 'restarted'; p.join();
  assert.equal(p.attempts.length, 0);
});

test('join history is not rewound by out-of-order feeds and never uses ordinary chat names', () => {
  const p = setup(); p.join('104', '최근 입장');
  p.advance(20_000); p.snapshot.at = p.time();
  p.snapshot.events = [{ roomId: ROOM, eventId: '103', at: p.time() - 25_000, members: [{ id: MEMBER, name: '늦은 과거' }] }];
  p.poll(); p.notify({ text: '대화만 함', sender: '채팅 이름' });
  p.advance(20_000); p.join('105');
  assert.match(p.attempts.at(-1).text, /이전 이름: 최근 입장/);
});

test('ordinary replies and greetings consume the same room budget; no extra limit notice', () => {
  const p = setup(); p.notify(); p.join();
  assert.equal(p.attempts.length, 1);
  p.advance(20_000); p.join('102');
  assert.equal(p.attempts.length, 3);
  assert.match(p.attempts.at(-1).text, /이전 이름:/);
});

test('state must be stored before sending; corrupt state and failed commit never send', () => {
  const p = setup(); p.setStoreFailure(true); p.join(); assert.equal(p.attempts.length, 0);
  const q = setup({ store: new Map([['pogeun-welcome/state', '{bad']]) });
  q.join(); assert.equal(q.attempts.length, 0); assert.ok(q.logs.length);
  const r = setup(); let reserved = false;
  r.setAfterCommit((name, key, value) => { if (name === 'pogeun-welcome') reserved ||= !!JSON.parse(value).pending; });
  r.context.welcomeConfirm = () => { assert.equal(reserved, true); return true; };
  r.join(); assert.equal(r.attempts.length, 1);
});

test('an unconfirmed greeting stops the history message and blocks later welcomes across restart', () => {
  const p = setup(); p.join(); p.advance(20_000);
  p.context.welcomeConfirm = () => false; p.join('102');
  assert.equal(p.attempts.length, 2, 'only first message of reentry was attempted');
  p.advance(20_000); p.join('103'); assert.equal(p.attempts.length, 2);
  const q = setup({ store: p.store, now: p.time() + 20_000 }); q.join('104'); assert.equal(q.attempts.length, 0);
  q.notify(); assert.equal(q.attempts.length, 1, 'normal command replies remain enabled');
});

test('recompile while waiting for a reply prevents sending and leaves reservation conservative', () => {
  const p = setup();
  p.setAfterCommit((name, key, value) => { if (name === 'pogeun-welcome' && JSON.parse(value).pending) p.context.onStartCompile(); });
  p.join(); assert.equal(p.attempts.length, 0);
});

test('two actual members are processed separately without treating the feed author as the entrant', () => {
  const p = setup({ policy: { roomIntervalMs: 1, userIntervalMs: 1 } });
  p.snapshot.events = [{ roomId: ROOM, eventId: '101', at: p.time(), members: [{ id: MEMBER, name: '회원1' }, { id: '777', name: '회원2' }] }];
  p.context.welcomeConfirm = () => { p.advance(5); return true; };
  p.poll(); assert.deepEqual(p.attempts.map(a => a.text), [formatWelcome('회원1', '검증방'), formatWelcome('회원2', '검증방')]);
});

test('confirmation requires the same room, current reader generation, fresh timestamp, later log and exact text', () => {
  const p = setup(); p.poll();
  const row = { roomId: ROOM, logId: '9007199254740995', at: p.time(), hash: createHash('sha256').update('인사').digest('hex') };
  p.snapshot.outgoing = [row];
  const check = () => p.context.welcomeConfirmed(plain(p.snapshot), ROOM, '인사', '9007199254740993', p.time());
  assert.equal(check(), true);
  for (const change of [{ roomId: '2' }, { logId: '9007199254740993' }, { logId: 9007199254740995 },
    { at: p.time()-2000 }, { hash: '0'.repeat(64) }]) {
    p.snapshot.outgoing = [{ ...row, ...change }]; assert.equal(check(), false);
  }
  p.snapshot.outgoing = [row]; p.snapshot.generation = 'changed'; assert.equal(check(), false);
});

test('reader unavailability recovers without replaying events from before script startup', () => {
  const p = setup(); const read = p.context.welcomeReadSnapshot;
  p.context.welcomeReadSnapshot = () => { throw new Error('missing'); };
  p.poll(); p.poll(); assert.equal(p.logs.length, 1);
  p.context.welcomeReadSnapshot = read;
  p.join(); assert.equal(p.attempts.length, 1);
});

test('a second failed send stays reserved and is not retried after restart', () => {
  const p = setup(); p.join(); p.advance(20_000);
  p.setReplyError(attempt => attempt === 3); p.join('102');
  assert.equal(p.attempts.length, 3);
  assert.ok(JSON.parse(p.store.get('pogeun-welcome/state')).pending);
  const q = setup({ store: p.store, now: p.time()+20_000 }); q.join('103'); assert.equal(q.attempts.length, 0);
});

test('unexpected stored fields and invalid member entries fail closed', () => {
  const p = setup(); p.join();
  const raw = JSON.parse(p.store.get('pogeun-welcome/state')); raw.chatText = 'not permitted';
  p.store.set('pogeun-welcome/state', JSON.stringify(raw));
  const q = setup({ store: p.store, now: p.time()+20_000 }); q.join('102'); assert.equal(q.attempts.length, 0);
});

test('known first-entry state remains truthful when the room lacks a reply action', () => {
  const p = setup(); p.context.bridgeSessions = []; p.join(); assert.equal(p.attempts.length, 0);
  p.advance(20_000); p.notify({ text: '새 알림' }); p.join('102');
  assert.equal(p.attempts.length, 2); assert.match(p.attempts[1].text, /이전 이름: 새 회원/);
});
