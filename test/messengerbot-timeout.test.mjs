import { createPhone, fixtureRoomIdentity } from './helpers/messengerbot-phone.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../scripts/messengerbot-r.js', import.meta.url), 'utf8');
function phone(responseDelayMs, payload) {
  let timeout;
  let sentBody;
  const connection = {
    ignoreContentType() { return this; }, ignoreHttpErrors() { return this; },
    header() { return this; }, method() { return this; },
    requestBody(body) { sentBody = JSON.parse(body); return this; },
    timeout(value) { timeout = value; return this; },
    execute() {
      // The installed Android Jsoup uses half its configured timeout for reads.
      if (responseDelayMs > timeout / 2) throw new Error('java.net.SocketTimeoutException: Read timed out');
      return { statusCode: () => 200, body: () => JSON.stringify(payload) };
    },
  };
  const context = vm.createContext({
    android: { os: { Build: { VERSION: { SDK_INT: 30 } } } },
    org: { jsoup: { Jsoup: { connect: () => connection }, Connection: { Method: { POST: 'POST' } } } },
    Log: { e() {} },
  });
  vm.runInContext(source, context, { filename: 'messengerbot-r.js' });
  context.SERVER_NOT_SET = false;
  return { context, request: () => ({ timeout, sentBody }) };
}

test('a simulated 17-second calculation returns its complete response within the socket read deadline', () => {
  const payload = { text: '❙ 합성캐릭터4님의 스펙업 효율\n1위 · 강화', link: null };
  const { context, request } = phone(17_112, payload);
  const identity = { key: 'fixture' };
  const result = context.askServer('검증방', '검증사용자', '.스펙업 합성캐릭터4', identity, fixtureRoomIdentity(), true);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), payload);
  assert.deepEqual(request().sentBody, { room: '검증방', sender: '검증사용자', text: '.스펙업 합성캐릭터4', attendanceIdentity: identity, roomIdentity: fixtureRoomIdentity(), isGroupChat: true });
  assert.equal(request().timeout / 2, 30_000);
});

test('the server can return its 25-second pending reply before the phone times out', () => {
  const payload = { text: '조회에 시간이 걸려요. 잠시 후 같은 명령을 다시 보내 주세요.', link: null };
  const { context } = phone(25_500, payload);
  assert.equal(context.askServer('검증방', '검증사용자', '.스펙업 합성캐릭터4').text, payload.text);
});

test('an allowed raw notification wakes an opted-in update poll at most once per 60 seconds', () => {
  const device = createPhone({ autoUpdates: true });
  const { context } = device;
  assert.ok(context.updateLock);
  const polls = [];
  context.pollUpdates = () => { polls.push(device.time()); context.lastUpdatePollAt = device.time(); };
  const chat = text => device.notify({ text });
  chat('오늘 점심 뭐 먹지');
  assert.equal(polls.length, 1);
  assert.equal(device.attempts.length, 0);
  chat('ㅋㅋㅋ');
  assert.equal(polls.length, 1);
  device.advance(61000);
  chat('안녕');
  assert.equal(polls.length, 2);

  context.lastUpdatePollAt = 0;
  context.updateBusy.set(true);
  chat('진행 중');
  assert.equal(polls.length, 2);
  context.updateBusy.set(false);
  context.bridgeExecutor = { execute(task) { task.run(); } };
  chat('다시 확인');
  assert.equal(polls.length, 3);
  assert.ok(device.logs.every(line => !/추가 조회를 시작하지 못했습니다/.test(line)));
});

test('the phone log gets a timed line only at startup, successful notice requests and failures', () => {
  const device = createPhone({ autoUpdates: true });
  const { context, logs } = device;
  assert.deepEqual(logs, ['포근해용 업데이트 알림: 12:00 자동 조회 시작(60초 주기)']);
  context.pollUpdates();
  assert.equal(context.lastUpdatePollAt, device.time());
  device.setFeed({ version: 1, ready: false, cursor: 0, events: [] });
  context.pollUpdates();
  assert.equal(logs.length, 1);

  device.setHttpError(new Error('java.net.SocketTimeoutException: Read timed out'));
  context.pollUpdates();
  assert.equal(logs.length, 2);
  assert.equal(logs[1], '포근해용 업데이트 알림: 12:00 조회하지 못했습니다. 다음 주기에 다시 확인합니다.');
  assert.equal(context.updateBusy.get(), false);
  device.setHttpError(null);

  device.notify({ text: '일반 대화' });
  const events = [{ id: 1, text: '첫 공지', expiresAt: device.time() + 60000 },
    { id: 2, text: '둘째 공지', expiresAt: device.time() + 60000 }];
  device.setFeed({ version: 1, ready: true, cursor: 2, events });
  context.pollUpdates();
  assert.equal(device.attempts.length, 1);
  assert.equal(logs.length, 3);
  assert.equal(logs[2], '포근해용 업데이트 알림: 12:00 공지 발송 1건');
  context.pollUpdates();
  assert.equal(device.attempts.length, 1);
  assert.equal(logs.length, 3);

  context.lastUpdatePollAt = 0;
  context.bridgeExecutor = { execute() { throw new Error('rejected'); } };
  context.java.lang.Thread = function () { this.start = () => { throw new Error('no thread'); }; };
  context.wakeUpdatePolling();
  assert.equal(logs.length, 4);
  assert.equal(logs[3], '포근해용 업데이트 알림: 12:00 메시지 수신 후 추가 조회를 시작하지 못했습니다.');
});

test('an unresponsive server reaches the existing guidance through a consented raw notification', () => {
  const device = createPhone();
  device.setHttpError(new Error('java.net.SocketTimeoutException: Read timed out'));
  device.notify({ text: '.스펙업 합성캐릭터4' });
  assert.deepEqual(device.attempts.map(attempt => attempt.text), ['봇 서버의 응답 시간이 초과됐어요. 잠시 후 다시 시도해 주세요.']);
  const { context } = phone(31000, { text: 'late' });
  assert.throws(() => context.askServer('검증방', '검증사용자', '.스펙업 합성캐릭터4', null, fixtureRoomIdentity(), true), /Read timed out/);
});
