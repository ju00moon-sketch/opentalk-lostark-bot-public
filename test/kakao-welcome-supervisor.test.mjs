import test from 'node:test';
import assert from 'node:assert/strict';
import { createWelcomeSupervisor } from '../src/kakao/welcome-supervisor.js';

async function flush() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class Clock {
  time = 0;
  nextId = 0;
  timers = new Map();
  now = () => this.time;
  setTimeout = (callback, delay) => {
    const id = ++this.nextId;
    this.timers.set(id, { callback, at: this.time + delay });
    return id;
  };
  clearTimeout = (id) => { this.timers.delete(id); };
  next() { return [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]; }
  fireNext() {
    const [id, timer] = this.next();
    this.timers.delete(id);
    this.time = timer.at;
    timer.callback();
  }
  async advance(duration) {
    const target = this.time + duration;
    let ticks = 0;
    while (this.next()?.[1].at <= target) {
      assert.ok(++ticks <= 20_000, 'unexpected timer loop');
      this.fireNext();
      await flush();
    }
    this.time = target;
    await flush();
  }
}
function setup(overrides = {}) {
  const clock = new Clock();
  const status = { connected: false, ready: true, busy: false, blocked: false };
  const calls = [];
  const errors = [];
  const supervisor = createWelcomeSupervisor({ getStatus: () => ({ ...status }),
    reconnect: async () => { calls.push(clock.time); throw new Error('temporary network failure'); },
    onError: (error) => errors.push(error), now: clock.now,
    setTimeoutImpl: clock.setTimeout, clearTimeoutImpl: clock.clearTimeout, ...overrides });
  return { supervisor, clock, status, calls, errors };
}

test('construction is idle and first reconnect starts exactly five seconds after start', async () => {
  const { supervisor, clock, calls } = setup();
  await clock.advance(60_000);
  assert.equal(calls.length, 0);
  supervisor.start();
  await clock.advance(4_999);
  assert.equal(calls.length, 0);
  await clock.advance(1);
  assert.deepEqual(calls, [65_000]);
  supervisor.stop();
});

test('initial unauthenticated configuration never triggers reconnect until the owner marks it ready', async () => {
  const { supervisor, clock, status, calls } = setup();
  status.ready = false;
  supervisor.start();
  await clock.advance(600_000);
  assert.equal(calls.length, 0);
  assert.equal(supervisor.getState().nextAttemptAt, null);
  status.ready = true;
  supervisor.check();
  await clock.advance(4_999);
  assert.equal(calls.length, 0);
  await clock.advance(1);
  assert.equal(calls.length, 1);
  supervisor.stop();
});

test('successive failures use 5, 15, 30, 60, then capped 300 second delays', async () => {
  const { supervisor, clock, calls } = setup();
  supervisor.start();
  await clock.advance(1_010_000);
  assert.deepEqual(calls, [5_000, 20_000, 50_000, 110_000, 410_000, 710_000, 1_010_000]);
  assert.equal(supervisor.getState().nextAttemptAt, 1_310_000);
  supervisor.stop();
});

test('backoff begins after a failed attempt settles, without overlapping a slow reconnect', async () => {
  const attempt = deferred();
  let calls = 0;
  const { supervisor, clock } = setup({ reconnect: () => { calls++; return attempt.promise; } });
  supervisor.start();
  await clock.advance(5_000);
  for (let i = 0; i < 20; i++) { supervisor.start(); supervisor.check(); }
  await clock.advance(20_000);
  assert.equal(calls, 1);
  assert.equal(supervisor.getState().reconnecting, true);
  attempt.reject(new Error('socket failed'));
  await flush();
  assert.equal(supervisor.getState().nextAttemptAt, 40_000);
  await clock.advance(14_999);
  assert.equal(calls, 1);
  await clock.advance(1);
  assert.equal(calls, 2);
  supervisor.stop();
});

test('repeated start and check leave one timer and one reconnect', async () => {
  const { supervisor, clock, calls } = setup();
  supervisor.start();
  for (let i = 0; i < 50; i++) { supervisor.start(); supervisor.check(); }
  assert.equal(clock.timers.size, 1);
  await clock.advance(5_000);
  assert.equal(calls.length, 1);
  assert.equal(clock.timers.size, 1);
  supervisor.stop();
});

test('stop cancels scheduled retries and ignores an already dequeued stale timer', async () => {
  const { supervisor, clock, calls } = setup();
  supervisor.start();
  const stale = clock.next()[1].callback;
  await clock.advance(4_999);
  supervisor.stop();
  stale();
  await clock.advance(600_000);
  assert.equal(calls.length, 0);
  assert.equal(clock.timers.size, 0);
});

test('a replaced timer cannot create a second polling loop in the same generation', async () => {
  const { supervisor, clock, calls } = setup();
  supervisor.start();
  const stale = clock.next()[1].callback;
  supervisor.check();
  stale();
  assert.equal(clock.timers.size, 1);
  await clock.advance(5_000);
  assert.equal(calls.length, 1);
  assert.equal(clock.timers.size, 1);
  supervisor.stop();
});

test('stop between the due timer and reconnect microtask prevents the account request', async () => {
  const { supervisor, clock, calls } = setup();
  supervisor.start();
  await clock.advance(4_000);
  clock.fireNext();
  supervisor.stop();
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(clock.timers.size, 0);
});

for (const outcome of ['resolve', 'reject']) {
  test(`in-flight ${outcome} after stop cannot report errors or schedule another attempt`, async () => {
    const attempt = deferred();
    let calls = 0;
    const { supervisor, clock, errors } = setup({ reconnect: () => { calls++; return attempt.promise; } });
    supervisor.start();
    await clock.advance(5_000);
    supervisor.stop();
    attempt[outcome](new Error('late result'));
    await flush();
    await clock.advance(600_000);
    assert.equal(calls, 1);
    assert.deepEqual(errors, []);
    assert.equal(clock.timers.size, 0);
    assert.equal(supervisor.getState().reconnecting, false);
  });
}

test('stop and restart retain the old in-flight lock until the old attempt settles', async () => {
  const oldAttempt = deferred();
  let calls = 0;
  const { supervisor, clock, errors } = setup({ reconnect: () => {
    calls++;
    return calls === 1 ? oldAttempt.promise : Promise.resolve();
  } });
  supervisor.start();
  await clock.advance(5_000);
  supervisor.stop();
  supervisor.start();
  await clock.advance(20_000);
  assert.equal(calls, 1);
  assert.equal(supervisor.getState().attempts, 0);
  oldAttempt.reject(new Error('old generation'));
  await flush();
  assert.deepEqual(errors, []);
  await clock.advance(4_999);
  assert.equal(calls, 1);
  await clock.advance(1_001);
  assert.equal(calls, 2);
  supervisor.stop();
});

test('busy postpones a due retry without increasing the failure count', async () => {
  const { supervisor, clock, status, calls } = setup();
  status.busy = true;
  supervisor.start();
  await clock.advance(30_000);
  assert.equal(calls.length, 0);
  assert.equal(supervisor.getState().attempts, 0);
  status.busy = false;
  supervisor.check();
  await flush();
  assert.deepEqual(calls, [30_000]);
  supervisor.stop();
});

test('blocked cancels retries and clearing the owner block starts a fresh delay', async () => {
  const { supervisor, clock, status, calls } = setup();
  supervisor.start();
  await clock.advance(4_999);
  status.blocked = true;
  supervisor.check();
  await clock.advance(600_000);
  assert.equal(calls.length, 0);
  assert.equal(supervisor.getState().nextAttemptAt, null);
  status.blocked = false;
  supervisor.check();
  await clock.advance(4_999);
  assert.equal(calls.length, 0);
  await clock.advance(1);
  assert.equal(calls.length, 1);
  supervisor.stop();
});

for (const [property, value] of [['blocked', true], ['busy', true], ['ready', false]]) {
  test(`fresh ${property} status is checked after the retry timer and before reconnect`, async () => {
    const { supervisor, clock, status, calls } = setup();
    supervisor.start();
    await clock.advance(4_000);
    clock.fireNext();
    status[property] = value;
    await flush();
    assert.equal(calls.length, 0);
    assert.equal(supervisor.getState().attempts, 0);
    supervisor.stop();
  });
}

test('a connection that fails again before 60 stable seconds retains its backoff', async () => {
  const { supervisor, clock, status } = setup();
  supervisor.start();
  await clock.advance(5_000);
  status.connected = status.ready = true;
  supervisor.check();
  await clock.advance(59_000);
  status.connected = false;
  supervisor.check();
  assert.equal(supervisor.getState().attempts, 1);
  assert.equal(supervisor.getState().nextAttemptAt, 79_000);
  supervisor.stop();
});

test('60 continuous ready seconds reset backoff even when ordinary work is busy', async () => {
  const { supervisor, clock, status } = setup();
  supervisor.start();
  await clock.advance(5_000);
  status.connected = status.ready = status.busy = true;
  supervisor.check();
  await clock.advance(60_000);
  assert.equal(supervisor.getState().attempts, 0);
  status.connected = status.busy = false;
  supervisor.check();
  assert.equal(supervisor.getState().nextAttemptAt, 70_000);
  supervisor.stop();
});

test('revoking configuration readiness cancels retries and cannot reset backoff', async () => {
  const { supervisor, clock, status } = setup();
  supervisor.start();
  await clock.advance(5_000);
  status.connected = status.busy = true;
  status.ready = false;
  supervisor.check();
  await clock.advance(60_000);
  assert.equal(supervisor.getState().attempts, 1);
  assert.equal(supervisor.getState().stableSince, null);
  supervisor.stop();
});

test('owner classifies a reconnect error as blocked before any new attempt is scheduled', async () => {
  const failure = Object.assign(new Error('authentication rejected'), { code: 'AUTH_REJECTED' });
  const status = { connected: false, ready: true, busy: false, blocked: false };
  let observed;
  let calls = 0;
  const { supervisor, clock } = setup({ getStatus: () => status,
    reconnect: async () => { calls++; throw failure; },
    onError: (error) => { observed = error; status.blocked = true; } });
  supervisor.start();
  await clock.advance(3_600_000);
  assert.equal(calls, 1);
  assert.equal(observed, failure);
  assert.equal(supervisor.getState().nextAttemptAt, null);
  supervisor.stop();
});

test('asynchronous error classification finishes before another reconnect may start', async () => {
  const classified = deferred();
  const status = { connected: false, ready: true, busy: false, blocked: false };
  let calls = 0;
  const { supervisor, clock } = setup({ getStatus: () => status,
    reconnect: async () => { calls++; throw new Error('rejected'); },
    onError: async () => { await classified.promise; status.blocked = true; } });
  supervisor.start();
  await clock.advance(60_000);
  assert.equal(calls, 1);
  assert.equal(supervisor.getState().reconnecting, true);
  classified.resolve();
  await flush();
  await clock.advance(300_000);
  assert.equal(calls, 1);
  assert.equal(supervisor.getState().reconnecting, false);
  supervisor.stop();
});

test('unreadable status prevents reconnect and reports once until status recovers', async () => {
  let readable = false;
  let calls = 0;
  const errors = [];
  const { supervisor, clock } = setup({ getStatus: () => {
    if (!readable) throw new Error('status unavailable');
    return { connected: false, ready: true, busy: false, blocked: false };
  }, reconnect: async () => { calls++; }, onError: (error) => errors.push(error.code) });
  supervisor.start();
  await clock.advance(60_000);
  assert.equal(calls, 0);
  assert.deepEqual(errors, ['SUPERVISOR_STATUS_FAILED']);
  readable = true;
  supervisor.check();
  await clock.advance(5_000);
  assert.equal(calls, 1);
  supervisor.stop();
});

test('invalid status is not interpreted as a disconnected session', async () => {
  const { supervisor, clock, calls, errors } = setup({ getStatus: () => ({ connected: false }) });
  supervisor.start();
  await clock.advance(60_000);
  assert.equal(calls.length, 0);
  assert.deepEqual(errors.map((error) => error.code), ['SUPERVISOR_STATUS_INVALID']);
  supervisor.stop();
});

for (const failure of ['throw', 'reject']) {
  test(`an onError ${failure} does not stop subsequent retries`, async () => {
    const { supervisor, clock, calls } = setup({ onError: () => {
      if (failure === 'throw') throw new Error('logging failed');
      return Promise.reject(new Error('logging failed'));
    } });
    supervisor.start();
    await clock.advance(20_000);
    assert.deepEqual(calls, [5_000, 20_000]);
    supervisor.stop();
  });
}

test('a delayed clock does not replay missed retries in a burst', async () => {
  const { supervisor, clock, calls } = setup();
  supervisor.start();
  clock.time = 600_000;
  supervisor.check();
  await flush();
  assert.deepEqual(calls, [600_000]);
  assert.equal(supervisor.getState().nextAttemptAt, 615_000);
  supervisor.stop();
});
