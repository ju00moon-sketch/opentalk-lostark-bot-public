import test from 'node:test';
import assert from 'node:assert/strict';
import { anchorBatches, anchorNames, msUntilNextRefresh, startRosterValueRefresh, MAX_ANCHORS, MAX_REQUESTS, REFRESH_HOUR_KST, REFRESH_MINUTE_KST, STARTUP_DELAY_MS } from '../src/roster-value-refresh.js';

const TOKEN = 'r'.repeat(40);
const HOUR = 60 * 60 * 1000;
const kst = (year, month, day, hour, minute = 0) => Date.UTC(year, month - 1, day, hour - 9, minute);

function harness({ links = { '1': '앞으로가나' }, status = null, refresh = async () => ({ status: 'started' }), token = TOKEN, at = kst(2026, 9, 19, 1) } = {}) {
  const timers = [];
  const calls = { refreshed: [], statuses: 0 };
  const logs = [];
  const clock = { now: at };
  const scheduler = startRosterValueRefresh({
    token, links: () => links, now: () => clock.now,
    readStatus: async () => { calls.statuses += 1; return status; },
    requestRefresh: async (names) => { calls.refreshed.push(names); return refresh(names); },
    setTimer: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
  });
  const fire = async () => { const timer = timers.pop(); assert.ok(timer, 'a timer was scheduled'); await timer.fn(); };
  return { scheduler, timers, calls, logs, clock, fire };
}

test('the daily slot is 03:30 KST and the first run waits ten minutes after start', () => {
  assert.equal(REFRESH_HOUR_KST, 3);
  assert.equal(REFRESH_MINUTE_KST, 30);
  assert.equal(STARTUP_DELAY_MS, 10 * 60 * 1000);
  assert.equal(msUntilNextRefresh(kst(2026, 9, 19, 2)), 90 * 60 * 1000);
  assert.equal(msUntilNextRefresh(kst(2026, 9, 19, 4)), 23.5 * HOUR);
  assert.equal(msUntilNextRefresh(kst(2026, 9, 19, 3, 30)), 24 * HOUR);
  // 수요일 06:00 재부팅·08:00 크리스탈 자동 갱신과 겹치지 않는다.
  assert.ok(REFRESH_HOUR_KST < 6);
});

const filled = count => Object.fromEntries(Array.from({ length: count }, (_, i) => [String(i), `채움${String(i).padStart(3, '0')}`]));

test('registered characters are de-duplicated and split into requests the site accepts', () => {
  assert.deepEqual(anchorNames({ '1': '앞으로가나', 'kakao:2': '앞으로가나', 'kakao:3': ' 합성캐릭터4 ', '4': '', '5': null }), ['앞으로가나', '합성캐릭터4']);
  assert.deepEqual(anchorNames(null), []);
  // 전에는 앞 64명에서 끊어 65번째부터는 한 번도 요청되지 않았다. 이제 전원을 64명씩 나눠 보낸다.
  const names = anchorNames(filled(80));
  assert.equal(names.length, 80);
  const batches = anchorBatches(names, kst(2026, 9, 19, 3, 30));
  assert.deepEqual(batches.map(batch => batch.length), [64, 16]);
  assert.deepEqual(batches.flat(), names, '상한 안이면 순서 그대로 모두 보낸다');
  assert.deepEqual(anchorBatches([], kst(2026, 9, 19, 3, 30)), []);
});

test('more registrations than the request cap come around within days', () => {
  // 64명 × 6요청 = 384명을 넘으면 날마다 시작 위치를 옮겨, 상한 밖의 등록자도 며칠 안에 한 번은 보낸다.
  const names = anchorNames(filled(MAX_ANCHORS * MAX_REQUESTS + 50));
  const seen = new Set();
  for (let day = 0; day < 7; day++) {
    const batches = anchorBatches(names, kst(2026, 9, 19 + day, 3, 30));
    assert.ok(batches.length <= MAX_REQUESTS && batches.every(batch => batch.length <= MAX_ANCHORS));
    for (const name of batches.flat()) seen.add(name);
  }
  assert.equal(seen.size, names.length, '일주일 안에 모든 등록자가 적어도 한 번 요청된다');
});

test('the 65th registered character is requested on the very first run', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { calls, clock, fire } = harness({ links: filled(65) });
  clock.now += STARTUP_DELAY_MS;
  await fire();
  assert.deepEqual(calls.refreshed.map(batch => batch.length), [64, 1]);
  assert.equal(calls.refreshed[1][0], '채움064');
});

test('the startup run asks the site to refresh every registered character and then sleeps until 03:30 KST', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { timers, calls, clock, fire, scheduler } = harness({ links: { '1': '앞으로가나', 'kakao:2': '합성캐릭터4', 'kakao:3': '앞으로가나' } });
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, STARTUP_DELAY_MS);
  clock.now += STARTUP_DELAY_MS;
  await fire();
  assert.deepEqual(calls.refreshed, [['앞으로가나', '합성캐릭터4']]);
  assert.equal(calls.statuses, 1);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, msUntilNextRefresh(clock.now));
  // The daily runs no longer consult the last success; only the startup run may skip.
  await fire();
  assert.equal(calls.refreshed.length, 2);
  assert.equal(calls.statuses, 1);
  scheduler.stop();
  assert.equal(timers.length, 1);
});

test('a refresh that already finished within a day is skipped once at start but still scheduled', async (t) => {
  t.mock.method(console, 'log', () => {});
  const at = kst(2026, 9, 19, 1);
  const { timers, calls, clock, fire } = harness({ status: { running: false, queued: 0, lastSuccessAt: at - 3 * HOUR }, at });
  clock.now += STARTUP_DELAY_MS;
  await fire();
  assert.deepEqual(calls.refreshed, []);
  assert.equal(timers[0].ms, msUntilNextRefresh(clock.now));
  await fire();
  assert.equal(calls.refreshed.length, 1, 'the next daily run goes ahead');
});

test('an older success, an unreachable site and a missing token all stay quiet and safe', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const at = kst(2026, 9, 19, 1);
  const stale = harness({ status: { running: false, queued: 0, lastSuccessAt: at - 30 * HOUR }, at });
  stale.clock.now += STARTUP_DELAY_MS;
  await stale.fire();
  assert.equal(stale.calls.refreshed.length, 1);

  const broken = harness({ status: null, refresh: async () => { throw new Error('offline'); } });
  broken.clock.now += STARTUP_DELAY_MS;
  await broken.fire();
  assert.equal(broken.timers.length, 1, 'a failed request still schedules the next run');

  const timers = [];
  const silent = startRosterValueRefresh({ token: undefined, links: () => ({ '1': '앞으로가나' }),
    requestRefresh: async () => { throw new Error('the scheduler must not ask without a token'); },
    readStatus: async () => { throw new Error('the scheduler must not ask without a token'); },
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return {}; } });
  assert.deepEqual(timers, []);
  silent.stop();
});
