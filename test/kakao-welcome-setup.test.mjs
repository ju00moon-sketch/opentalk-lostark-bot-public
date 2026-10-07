import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createContext, Script } from 'node:vm';
import { createWelcomeLogin } from '../src/kakao/welcome-login.js';
import { createWelcomeSetup } from '../src/kakao/welcome-setup.js';
import { WelcomeError } from '../src/kakao/welcome.js';

const EMAIL = 'maintainer@example.com';
const PASSWORD = 'synthetic-password-never-persist';
const CREDENTIAL = { accessToken: 'synthetic-access-token', userId: '500' };
const NEED_REGISTRATION = { success: false, status: -100 };
const OK = { success: true, status: 0, result: CREDENTIAL };
const GENERATED = { success: true, status: 0, result: { passcode: '012345', remainingSeconds: 120 } };
const TOKEN = 'a'.repeat(64);
const NOW = 1_789_209_693_000;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function loginFixture(options = {}) {
  let time = NOW;
  const calls = [];
  const api = {
    async login(form, forced) { calls.push(['login', { ...form }, forced]); return OK; },
    async generatePasscode(form, options) { calls.push(['generate', { ...form }, options]); return GENERATED; },
    async pollPasscode(form, options) { calls.push(['poll', { ...form }, options]); return { success: false, status: -100, result: {} }; },
    ...options.api,
  };
  const connected = [];
  const login = createWelcomeLogin({ api, connect: async (credential) => { connected.push(credential); }, now: () => time, ...options, api });
  return { login, calls, connected, advance(ms) { time += ms; }, now: () => time };
}
const submitLogin = login => login.action('login', { email: ` ${EMAIL} `, password: PASSWORD });
async function pendingFixture(t, options = {}) {
  const f = loginFixture({ ...options, api: { async login() { return NEED_REGISTRATION; }, ...options.api } });
  t.after(() => f.login.close());
  await submitLogin(f.login);
  await f.login.action('request-code');
  return f;
}
async function httpFixture(t, options = {}) {
  const calls = [];
  const service = createWelcomeSetup({ token: TOKEN, status: () => ({ stage: 'login', busy: false }), action: async (...args) => { calls.push(args); }, ...options });
  const url = await service.listen(0);
  t.after(() => service.close());
  const origin = new URL(url).origin;
  const post = (body, headers = {}) => fetch(url, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { service, url, origin, calls, post };
}

test('existing PC login never forces another session and exposes only state', async () => {
  const { login, calls, connected } = loginFixture();
  await submitLogin(login);
  assert.deepEqual(calls, [['login', { email: EMAIL, password: PASSWORD }, false]]);
  assert.deepEqual(connected, [CREDENTIAL]);
  assert.deepEqual(login.status(), { stage: 'connected', busy: false });
  await assert.rejects(submitLogin(login), /ALREADY_CONNECTED/);
  assert.equal(calls.length, 1);
});

test('new PC explicitly generates a code, waits for mobile approval and logs in again without force', async (t) => {
  let loginCalls = 0;
  const calls = [];
  const f = loginFixture({ api: {
    async login(form, forced) { calls.push(['login', { ...form }, forced]); return ++loginCalls === 1 ? NEED_REGISTRATION : OK; },
    async generatePasscode(form, { signal }) { calls.push(['generate', { ...form }]); assert.equal(signal.aborted, false); return GENERATED; },
    async pollPasscode(form, { signal }) { calls.push(['poll', { ...form }]); assert.equal(signal.aborted, false); return { success: true, status: 0 }; },
  } });
  t.after(() => f.login.close());
  await submitLogin(f.login);
  assert.deepEqual(f.login.status(), { stage: 'registration_required', busy: false });
  assert.equal(calls.length, 1);
  await f.login.action('request-code');
  assert.deepEqual(f.login.status(), { stage: 'awaiting_approval', busy: false, challenge: { passcode: '012345', expiresAt: NOW + 120000, nextPollAt: NOW + 3000 } });
  assert.equal(calls.length, 2);
  assert.ok(!JSON.stringify(f.login.status()).includes(PASSWORD));
  assert.ok(!JSON.stringify(f.login.status()).includes(EMAIL));
  f.advance(3000);
  await f.login.action('check-approval');
  assert.deepEqual(calls.map(call => call[0]), ['login', 'generate', 'poll', 'login']);
  assert.equal(calls[0][2], false); assert.equal(calls[3][2], false);
  assert.deepEqual(f.connected, [CREDENTIAL]);
  assert.deepEqual(f.login.status(), { stage: 'connected', busy: false });
});

test('waiting approval obeys the minimum and server interval while expiry can only shorten', async (t) => {
  const replies = [ { success: false, status: -100, result: { remainingSeconds: 60, nextRequestIntervalInSeconds: 7 } },
    { success: false, status: -100, result: { remainingSeconds: 500, nextRequestIntervalInSeconds: 1 } },
    { success: false, status: -100, result: { remainingSeconds: null, nextRequestIntervalInSeconds: null } } ];
  let polls = 0;
  const f = await pendingFixture(t, { api: { async pollPasscode() { return replies[polls++]; } } });
  await assert.rejects(f.login.action('check-approval'), /APPROVAL_CHECK_TOO_SOON/);
  assert.equal(polls, 0);
  f.advance(3000); await f.login.action('check-approval');
  const shortened = f.login.status().challenge.expiresAt;
  assert.equal(shortened, NOW + 63000);
  f.advance(6999); await assert.rejects(f.login.action('check-approval'), /APPROVAL_CHECK_TOO_SOON/);
  assert.equal(polls, 1);
  f.advance(1); await f.login.action('check-approval');
  assert.equal(f.login.status().challenge.expiresAt, shortened);
  assert.equal(f.login.status().challenge.nextPollAt, f.now() + 3000);
  f.advance(3000); await f.login.action('check-approval');
  assert.equal(f.login.status().challenge.expiresAt, shortened);
  assert.equal(f.login.status().challenge.nextPollAt, f.now() + 3000);
});

test('a generated challenge cannot be regenerated or approved out of order', async (t) => {
  const f = await pendingFixture(t);
  await assert.rejects(f.login.action('request-code'), /REGISTRATION_NOT_REQUESTED/);
  assert.equal(f.login.status().stage, 'awaiting_approval');
  assert.equal(f.calls.length, 1);
  await f.login.action('cancel');
  await assert.rejects(f.login.action('check-approval'), /APPROVAL_NOT_REQUESTED/);
  await assert.rejects(f.login.action('register', { code: '123456' }), /UNKNOWN_LOGIN_ACTION/);
  assert.equal(f.calls.length, 1);
});

test('challenge expiry erases state before another API request and does not generate another code', async (t) => {
  const f = await pendingFixture(t);
  f.advance(120000);
  assert.deepEqual(f.login.status(), { stage: 'login', busy: false });
  await assert.rejects(f.login.action('check-approval'), /APPROVAL_NOT_REQUESTED/);
  await assert.rejects(f.login.action('request-code'), /REGISTRATION_NOT_REQUESTED/);
  assert.equal(f.calls.length, 1);
});

test('the credential deadline remains ten minutes from login even after delayed generation', async (t) => {
  const f = loginFixture({ api: { async login() { return NEED_REGISTRATION; }, async generatePasscode() {
    return { ...GENERATED, result: { ...GENERATED.result, remainingSeconds: 1000 } };
  } } });
  t.after(() => f.login.close());
  await submitLogin(f.login);
  f.advance(590000); await f.login.action('request-code');
  assert.equal(f.login.status().challenge.expiresAt, NOW + 600000);
  f.advance(10000);
  assert.deepEqual(f.login.status(), { stage: 'login', busy: false });
});

test('invalid generated codes or unknown expiration never expose a challenge', async (t) => {
  for (const result of [{ passcode: 'bad', remainingSeconds: 120 }, { passcode: 123456, remainingSeconds: 120 },
    { passcode: '123456' }, { passcode: '123456', remainingSeconds: null }, { passcode: '123456', remainingSeconds: '120' },
    { passcode: '123456', remainingSeconds: 0 }, { passcode: '123456', remainingSeconds: -1 }]) {
    const f = loginFixture({ api: { async login() { return NEED_REGISTRATION; }, async generatePasscode() { return { success: true, status: 0, result }; } } });
    t.after(() => f.login.close()); await submitLogin(f.login);
    await assert.rejects(f.login.action('request-code'), /AUTH_PASSCODE_INVALID|AUTH_CHALLENGE_INVALID/);
    assert.deepEqual(f.login.status(), { stage: 'login', busy: false });
  }
});

test('invalid waiting values fail closed and remaining zero expires the challenge', async (t) => {
  for (const result of [{ remainingSeconds: -1 }, { remainingSeconds: '60' },
    { nextRequestIntervalInSeconds: -1 }, { nextRequestIntervalInSeconds: '3' }, { remainingSeconds: 0 }]) {
    const f = await pendingFixture(t, { api: { async pollPasscode() { return { success: false, status: -100, result }; } } });
    f.advance(3000);
    await assert.rejects(f.login.action('check-approval'), /AUTH_APPROVAL_RESPONSE_INVALID|LOGIN_EXPIRED/);
    assert.deepEqual(f.login.status(), { stage: 'login', busy: false });
  }
});

test('late generation after cancellation, expiry or shutdown cannot restore a code', async (t) => {
  for (const stop of ['cancel', 'expiry', 'close']) {
    const waiting = deferred(); let signal;
    const f = loginFixture({ api: { async login() { return NEED_REGISTRATION; }, async generatePasscode(_form, options) { signal = options.signal; return waiting.promise; } } });
    t.after(() => f.login.close()); await submitLogin(f.login);
    const running = f.login.action('request-code');
    await assert.rejects(f.login.action('request-code'), /LOGIN_BUSY/);
    if (stop === 'cancel') await f.login.action('cancel');
    else if (stop === 'expiry') { f.advance(600000); f.login.status(); }
    else f.login.close();
    assert.equal(signal.aborted, true);
    waiting.resolve(GENERATED); await assert.rejects(running, /LOGIN_EXPIRED/);
    assert.deepEqual(f.login.status(), { stage: 'login', busy: false });
    assert.equal(f.connected.length, 0);
  }
});

test('late poll approval after cancellation, expiry or shutdown cannot issue a new login', async (t) => {
  for (const stop of ['cancel', 'expiry', 'close']) {
    const waiting = deferred(); let signal, logins = 0;
    const f = await pendingFixture(t, { api: { async login() { logins++; return NEED_REGISTRATION; },
      async pollPasscode(_form, options) { signal = options.signal; return waiting.promise; } } });
    f.advance(3000); const running = f.login.action('check-approval');
    if (stop === 'cancel') await f.login.action('cancel');
    else if (stop === 'expiry') { f.advance(120000); f.login.status(); }
    else f.login.close();
    assert.equal(signal.aborted, true);
    waiting.resolve({ success: true, status: 0 }); await assert.rejects(running, /LOGIN_EXPIRED/);
    assert.equal(logins, 1); assert.equal(f.connected.length, 0);
    assert.equal(f.login.status().challenge, undefined);
  }
});

test('post-approval login completing after challenge expiry cannot connect', async (t) => {
  const waiting = deferred(); let logins = 0;
  const f = await pendingFixture(t, { api: { async login(_form, forced) { assert.equal(forced, false); return ++logins === 1 ? NEED_REGISTRATION : waiting.promise; },
    async pollPasscode() { return { success: true, status: 0 }; } } });
  f.advance(3000); const running = f.login.action('check-approval');
  await new Promise(setImmediate);
  f.advance(120000); f.login.status(); waiting.resolve(OK);
  await assert.rejects(running, /LOGIN_EXPIRED/);
  assert.equal(logins, 2); assert.equal(f.connected.length, 0);
});

test('the expiry timer clears an unobserved challenge without status polling', async (t) => {
  const f = loginFixture({ now: Date.now, api: { async login() { return NEED_REGISTRATION; }, async generatePasscode() {
    return { ...GENERATED, result: { ...GENERATED.result, remainingSeconds: 0.02 } };
  } } });
  t.after(() => f.login.close()); await submitLogin(f.login); await f.login.action('request-code');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(f.login.status(), { stage: 'login', busy: false });
  await assert.rejects(f.login.action('check-approval'), /APPROVAL_NOT_REQUESTED/);
});

test('password and conflicting-PC errors never trigger code generation or forced login', async () => {
  for (const status of [-101, 12, 13]) {
    let attempts = 0;
    const f = loginFixture({ api: { async login(_form, forced) { assert.equal(forced, false); attempts++; return { success: false, status }; } } });
    await assert.rejects(submitLogin(f.login), new RegExp(`AUTH_STATUS_${status}`));
    assert.deepEqual(f.login.status(), { stage: 'login', busy: false });
    await assert.rejects(f.login.action('request-code'), /REGISTRATION_NOT_REQUESTED/);
    assert.equal(attempts, 1); assert.equal(f.calls.length, 0);
  }
});

test('invalid login fields and parallel logins fail before extra authentication', async () => {
  const waiting = deferred();
  const f = loginFixture({ api: { async login() { return waiting.promise; } } });
  for (const input of [{}, { email: EMAIL, password: '' }, { email: EMAIL, password: 'x'.repeat(513) }, { email: 'x'.repeat(255), password: PASSWORD }])
    await assert.rejects(f.login.action('login', input), /LOGIN_FIELDS_REQUIRED/);
  const running = submitLogin(f.login);
  await assert.rejects(submitLogin(f.login), /LOGIN_BUSY/);
  waiting.resolve(OK); await running;
  assert.equal(f.connected.length, 1);
});

test('only code-generation HTTP 404 becomes a blocked phase-specific failure', async (t) => {
  for (const source of ['AUTH_HTTP_404', 'AUTH_HTTP_404_STATUS_-100']) {
    let logins = 0, generations = 0;
    const f = loginFixture({ api: { async login() { logins++; return NEED_REGISTRATION; }, async generatePasscode() { generations++; throw new WelcomeError(source); } } });
    t.after(() => f.login.close()); await submitLogin(f.login);
    const code = source.replace('AUTH_HTTP_', 'AUTH_PASSCODE_HTTP_');
    await assert.rejects(f.login.action('request-code'), { code });
    f.advance(600000);
    assert.deepEqual(f.login.status(), { stage: 'passcode_unavailable', busy: false });
    await assert.rejects(submitLogin(f.login), { code });
    await assert.rejects(f.login.action('request-code'), { code });
    assert.equal(logins, 1); assert.equal(generations, 1);
  }
  const f = loginFixture({ api: { async login() { throw new WelcomeError('AUTH_HTTP_404'); } } });
  await assert.rejects(submitLogin(f.login), { code: 'AUTH_HTTP_404' });
  assert.equal(f.login.status().stage, 'login');
});
test('setup page uses loopback and its inline browser script parses', async (t) => {
  const { url } = await httpFixture(t);
  assert.equal(new URL(url).hostname, '127.0.0.1');
  const response = await fetch(url);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Script(script));
  assert.match(script, /\$\('password'\)\.value=''/);
  assert.match(script, /approval-code/);
  assert.doesNotMatch(script, /localStorage|sessionStorage|document\.cookie/);
});

test('setup token, Host and exact action path protect every action', async (t) => {
  assert.throws(() => createWelcomeSetup({ token: 'short' }), /INVALID_SETUP_TOKEN/);
  const { url, origin, calls } = await httpFixture(t);
  for (const path of ['/setup/' + 'b'.repeat(64), '/setup/' + TOKEN.slice(1), '/setup/' + TOKEN + '/extra']) {
    assert.equal((await fetch(origin + path)).status, 404);
  }
  const rejectedHost = await new Promise((resolve, reject) => {
    const req = request(url, { headers: { host: 'attacker.example.invalid' } }, (res) => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.end();
  });
  assert.equal(rejectedHost, 404);
  assert.equal((await fetch(url + '?status', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' })).status, 404);
  assert.equal((await fetch(url, { method: 'PUT' })).status, 404);
  assert.equal(calls.length, 0);
});

test('setup rejects missing, foreign or null Origin and non-JSON bodies', async (t) => {
  const { url, origin, calls } = await httpFixture(t);
  for (const headers of [{ 'content-type': 'application/json' },
    { origin: 'https://attacker.example.invalid', 'content-type': 'application/json' },
    { origin: 'null', 'content-type': 'application/json' },
    { origin, 'content-type': 'text/plain' }, { origin, 'content-type': 'application/jsonp' }]) {
    const response = await fetch(url, { method: 'POST', headers, body: '{}' });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'ORIGIN_REQUIRED' });
  }
  assert.equal(calls.length, 0);
});

test('setup body limits and malformed JSON cannot reach authentication APIs', async (t) => {
  const { url, origin, calls, post } = await httpFixture(t);
  for (const body of ['{', 'null', '[]', '"text"', JSON.stringify({ padding: 'x'.repeat(8193) })]) {
    const response = await fetch(url, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body });
    assert.equal(response.status, 400);
    const error = await response.json();
    assert.ok(['INVALID_SETUP_JSON', 'SETUP_REQUEST_FAILED', 'SETUP_BODY_TOO_LARGE'].includes(error.error));
  }
  assert.equal(calls.length, 0);
  assert.equal((await post({ action: 'cancel' })).status, 200);
  assert.equal(calls.length, 1);
});

test('setup serializes authentication requests and recovers after the pending action', async (t) => {
  const entered = deferred();
  const waiting = deferred();
  let calls = 0;
  const { post } = await httpFixture(t, { action: async () => { calls++; entered.resolve(); await waiting.promise; } });
  const running = post({ action: 'login', email: EMAIL, password: PASSWORD });
  await entered.promise;
  const concurrent = await post({ action: 'register', code: '123456' });
  assert.equal(concurrent.status, 409);
  assert.deepEqual(await concurrent.json(), { error: 'LOGIN_BUSY' });
  assert.equal(calls, 1);
  waiting.resolve();
  assert.equal((await running).status, 200);
  assert.equal((await post({ action: 'cancel' })).status, 200);
  assert.equal(calls, 2);
});

test('setup never returns raw SDK errors, passwords or access tokens', async (t) => {
  const { login } = loginFixture({ api: { async login() {
    throw new Error(`SDK credentials: ${PASSWORD} token=${CREDENTIAL.accessToken}`);
  } } });
  const { post, url } = await httpFixture(t, { action: (...args) => login.action(...args), status: () => login.status() });
  const response = await post({ action: 'login', email: EMAIL, password: PASSWORD });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'SETUP_REQUEST_FAILED' });
  const status = await (await fetch(url + '?status')).text();
  assert.ok(!status.includes(PASSWORD));
  assert.ok(!status.includes(EMAIL));
  assert.ok(!status.includes(CREDENTIAL.accessToken));
  assert.deepEqual(JSON.parse(status), { stage: 'login', busy: false });
});

test('challenge lifetimes use request time and never include response delivery latency', async (t) => {
  let time = NOW;
  const f = loginFixture({ now: () => time, api: {
    async login() { return NEED_REGISTRATION; },
    async generatePasscode() { time += 2500; return GENERATED; },
    async pollPasscode() { time += 4000; return { success: false, status: -100, result: { remainingSeconds: 30, nextRequestIntervalInSeconds: 3 } }; },
  } });
  t.after(() => f.login.close()); await submitLogin(f.login); await f.login.action('request-code');
  assert.equal(f.login.status().challenge.expiresAt, NOW + 120000);
  time += 3000; const sentAt = time;
  await f.login.action('check-approval');
  assert.equal(f.login.status().challenge.expiresAt, sentAt + 30000);
  assert.equal(f.login.status().challenge.nextPollAt, time + 3000);
});

test('already expired generated responses and canceled HTTP errors cannot revive authentication', async (t) => {
  let time = NOW;
  const f = loginFixture({ now: () => time, api: { async login() { return NEED_REGISTRATION; }, async generatePasscode() {
    time += 5000; return { ...GENERATED, result: { ...GENERATED.result, remainingSeconds: 1 } };
  } } });
  t.after(() => f.login.close()); await submitLogin(f.login);
  await assert.rejects(f.login.action('request-code'), /LOGIN_EXPIRED/);
  assert.deepEqual(f.login.status(), { stage: 'login', busy: false });
  const waiting = deferred();
  const second = loginFixture({ api: { async login() { return NEED_REGISTRATION; }, async generatePasscode() { return waiting.promise; } } });
  t.after(() => second.login.close()); await submitLogin(second.login);
  const pending = second.login.action('request-code'); await second.login.action('cancel');
  waiting.reject(new WelcomeError('AUTH_HTTP_404'));
  await assert.rejects(pending, /LOGIN_EXPIRED/);
  assert.deepEqual(second.login.status(), { stage: 'login', busy: false });
});

test('only the protected GET status exposes the in-memory code; POST and HTML omit it', async (t) => {
  const challenge = { passcode: '864209', expiresAt: NOW + 120000, nextPollAt: NOW + 3000 };
  const { url, post } = await httpFixture(t, { status: () => ({ stage: 'awaiting_approval', busy: false, challenge }) });
  const action = await post({ action: 'request-code' });
  assert.equal(action.status, 200);
  const body = await action.json();
  assert.equal(body.challenge, undefined);
  assert.ok(!JSON.stringify(body).includes(challenge.passcode));
  assert.ok(!(await (await fetch(url)).text()).includes(challenge.passcode));
  assert.deepEqual((await (await fetch(url + '?status')).json()).challenge, challenge);
  assert.equal((await fetch(url + '?unknown')).status, 404);
});

async function browserFixture(t, initialStatus, onPost, wallSkew = 0) {
  const { url } = await httpFixture(t);
  const html = await (await fetch(url)).text();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  const elements = new Map(), buttons = Array.from({ length: 5 }, () => ({ disabled: false }));
  const requests = [], timers = new Map(); let time = NOW, serial = 0, serverState = initialStatus;
  const element = id => {
    if (!elements.has(id)) { const classes = new Set(); elements.set(id, { value: '', textContent: '', classes,
      classList: { toggle(name, yes) { yes ? classes.add(name) : classes.delete(name); } },
      replaceChildren() {}, append() {}, querySelectorAll() { return []; } }); }
    return elements.get(id);
  };
  class Clock extends Date { static now() { return time + wallSkew; } }
  const context = createContext({ Date: Clock, performance: { now: () => time - NOW },
    document: { getElementById: element, querySelectorAll: () => buttons,
      createElement: () => ({ append() {} }), createTextNode: text => text },
    location: { pathname: '/setup/synthetic-test-token' }, setInterval() {},
    setTimeout(fn, delay) { timers.set(++serial, { fn, at: time + delay }); return serial; },
    clearTimeout(id) { timers.delete(id); },
    fetch: async (_url, options = {}) => {
      if (options.method === 'POST') {
        const body = JSON.parse(options.body); requests.push(body);
        return onPost ? onPost(body, state => { serverState = state; }, time) : { ok: true, json: async () => ({ stage: serverState.stage }) };
      }
      return { ok: true, json: async () => ({ ...serverState, serverNow: time }) };
    },
  });
  new Script(script).runInContext(context); await new Promise(setImmediate);
  return { element, buttons, requests, timers,
    run: code => new Script(code).runInContext(context),
    setStatus(state) { serverState = state; },
    async refresh() { await new Script('refresh()').runInContext(context); },
    async advance(ms) {
      time += ms;
      const due = [...timers.entries()].filter(([, task]) => task.at <= time);
      for (const [id, task] of due) { timers.delete(id); task.fn(); }
      await new Promise(setImmediate);
    } };
}

test('the browser displays the issued code and polls automatically at the server-provided interval', async (t) => {
  const state = { stage: 'awaiting_approval', runtime: 'server', rooms: [], sending: false,
    challenge: { passcode: '012345', expiresAt: NOW + 60000, nextPollAt: NOW + 3000 } };
  const page = await browserFixture(t, state, (_body, update, time) => {
    update({ ...state, challenge: { ...state.challenge, nextPollAt: time + 7000 } });
    return { ok: true, json: async () => ({ stage: 'awaiting_approval' }) };
  });
  assert.equal(page.element('approval-code').textContent, '012345');
  assert.equal(page.element('approval').classes.has('hidden'), false);
  assert.ok(page.element('login').classes.has('hidden'));
  assert.match(page.element('runtime').textContent, /상시 서버/);
  await page.advance(2999); assert.equal(page.requests.length, 0);
  await page.advance(1); assert.deepEqual(page.requests, [{ action: 'check-approval' }]);
  await page.advance(6999); assert.equal(page.requests.length, 1);
  await page.advance(1); assert.equal(page.requests.length, 2);
  assert.ok(page.requests.every(item => item.action === 'check-approval'));
});

test('the browser erases an expired code and never polls or regenerates after expiry', async (t) => {
  const page = await browserFixture(t, { stage: 'awaiting_approval', rooms: [],
    challenge: { passcode: '012345', expiresAt: NOW + 1000, nextPollAt: NOW + 3000 } });
  page.setStatus({ stage: 'login', rooms: [] });
  await page.advance(1000);
  assert.equal(page.element('approval-code').textContent, '');
  assert.equal(page.requests.length, 0);
  assert.equal(page.timers.size, 0);
  await page.refresh();
  assert.equal(page.element('login').classes.has('hidden'), false);
});

test('successful approval and explicit cancellation both remove the code and stop browser polling', async (t) => {
  for (const action of ['check-approval', 'cancel']) {
    const page = await browserFixture(t, { stage: 'awaiting_approval', rooms: [],
      challenge: { passcode: '012345', expiresAt: NOW + 60000, nextPollAt: NOW + 3000 } }, (_body, update) => {
      update({ stage: action === 'cancel' ? 'login' : 'connected', rooms: [] });
      return { ok: true, json: async () => ({}) };
    });
    if (action === 'cancel') await page.run("call('cancel')"); else await page.advance(3000);
    assert.equal(page.element('approval-code').textContent, '');
    assert.equal(page.timers.size, 0);
    assert.deepEqual(page.requests, [{ action }]);
  }
});

test('phase-specific generation failure hides retry controls, including after restoring the stored error', async (t) => {
  const code = 'AUTH_PASSCODE_HTTP_404_STATUS_-100';
  const page = await browserFixture(t, { stage: 'registration_required', runtime: 'server', rooms: [] }, () =>
    ({ ok: false, json: async () => ({ error: code }) }));
  page.element('password').value = PASSWORD;
  await page.run("call('request-code')");
  assert.equal(page.element('password').value, '');
  assert.match(page.element('status').textContent, /다시 로그인하지 않아도 됩니다/);
  assert.ok(page.buttons.every(button => button.disabled));
  assert.match(page.element('runtime').textContent, /상시 서버/);
  await page.run("call('login',{email:'unused',password:'unused'})");
  await page.run("call('request-code')");
  assert.deepEqual(page.requests, [{ action: 'request-code' }]);
  page.setStatus({ stage: 'login', error: code, rooms: [] }); await page.refresh();
  assert.ok(page.element('login').classes.has('hidden'));
  assert.ok(page.buttons.every(button => button.disabled));
});

test('loopback cancellation bypasses a pending poll without releasing that poll request lock', async (t) => {
  const waiting = deferred(), entered = deferred(); let signal, logins = 0;
  const f = await pendingFixture(t, { api: { async login() { logins++; return NEED_REGISTRATION; },
    async pollPasscode(_form, options) { signal = options.signal; entered.resolve(); return waiting.promise; } } });
  const { post } = await httpFixture(t, { status: () => f.login.status(), action: (...args) => f.login.action(...args) });
  f.advance(3000);
  const pending = post({ action: 'check-approval' }); await entered.promise;
  const canceled = await post({ action: 'cancel' });
  assert.equal(canceled.status, 200);
  assert.equal((await canceled.json()).challenge, undefined);
  assert.equal(signal.aborted, true);
  const concurrent = await post({ action: 'login', email: EMAIL, password: PASSWORD });
  assert.equal(concurrent.status, 409);
  assert.equal(logins, 1);
  waiting.resolve({ success: true, status: 0 });
  const late = await pending;
  assert.equal(late.status, 400);
  assert.deepEqual(await late.json(), { error: 'LOGIN_EXPIRED' });
  assert.equal(f.connected.length, 0);
  assert.deepEqual(f.login.status(), { stage: 'login', busy: false });
  assert.equal((await post({ action: 'login', email: EMAIL, password: PASSWORD })).status, 200);
  assert.equal(logins, 2);
});

test('browser cancellation remains available during a pending poll and cannot unlock a new login early', async (t) => {
  const waiting = deferred(), entered = deferred();
  const page = await browserFixture(t, { stage: 'awaiting_approval', rooms: [],
    challenge: { passcode: '012345', expiresAt: NOW + 60000, nextPollAt: NOW + 3000 } }, (body, update) => {
    if (body.action === 'check-approval') { entered.resolve(); return waiting.promise; }
    assert.equal(body.action, 'cancel');
    update({ stage: 'login', rooms: [] });
    return { ok: true, json: async () => ({ stage: 'login', busy: true }) };
  });
  const pending = page.run("call('check-approval')"); await entered.promise;
  assert.equal(page.element('cancel').disabled, false);
  await page.run("call('cancel')");
  assert.equal(page.element('approval-code').textContent, '');
  await page.run("call('login',{email:'unused',password:'unused'})");
  assert.deepEqual(page.requests, [{ action: 'check-approval' }, { action: 'cancel' }]);
  waiting.resolve({ ok: false, json: async () => ({ error: 'LOGIN_EXPIRED' }) }); await pending;
  assert.equal(page.timers.size, 0);
  assert.equal(page.element('approval-code').textContent, '');
  assert.equal(page.element('login').classes.has('hidden'), false);
});

test('browser clock skew cannot accelerate approval checks, including a too-soon response', async (t) => {
  for (const skew of [-10000, 10000]) {
    const page = await browserFixture(t, { stage: 'awaiting_approval', rooms: [],
      challenge: { passcode: '012345', expiresAt: NOW + 60000, nextPollAt: NOW + 3000 } }, () =>
      ({ ok: false, json: async () => ({ error: 'APPROVAL_CHECK_TOO_SOON' }) }), skew);
    assert.equal(page.element('approval-code').textContent, '012345');
    await page.advance(2999); assert.equal(page.requests.length, 0);
    await page.advance(1); assert.equal(page.requests.length, 1);
    await page.advance(0); assert.equal(page.requests.length, 1);
    await page.advance(2999); assert.equal(page.requests.length, 1);
    await page.advance(1); assert.equal(page.requests.length, 2);
    assert.ok(page.requests.every(body => body.action === 'check-approval'));
  }
});
