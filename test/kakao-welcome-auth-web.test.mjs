import test from 'node:test';
import assert from 'node:assert/strict';
import { createWelcomeAuthWeb, createWelcomePasscodeApi } from '../src/kakao/welcome-auth-web.js';
import { WelcomeError } from '../src/kakao/welcome.js';

const LOGIN = 'win32/account/login.json';
const EMAIL = 'maintainer@example.com';
const PASSWORD = 'synthetic password + & = 한글';
const TOKEN = 'synthetic-private-access-token';
const FORM = { email: EMAIL, password: PASSWORD, device_uuid: 'synthetic-device', forced: false };

function response(body = '{"status":0}', status = 200) {
  return new Response(body, { status });
}
function fixture(result = response()) {
  const calls = [];
  const web = createWelcomeAuthWeb({ fetchImpl: async (...args) => {
    calls.push(args);
    return typeof result === 'function' ? result(...args) : result;
  } });
  return { web, calls };
}
async function rejectsCode(promise, code) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof WelcomeError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    const visible = `${error.stack}\n${JSON.stringify(error)}`;
    for (const secret of [EMAIL, PASSWORD, TOKEN]) assert.ok(!visible.includes(secret));
    assert.equal(error.cause, undefined);
    return true;
  });
}

test('login preserves authentication headers, form values and forced=false on the pinned origin', async () => {
  const { web, calls } = fixture();
  const headers = { A: 'win32/26.4.0/ko', Accept: '*/*', 'Accept-Language': 'ko',
    'User-Agent': 'KT/26.4.0 Wd/10.0 ko', 'X-VC': 'synthetic-xvc' };
  const form = { ...FORM, device_name: 'OpenTalk Welcome Server', unused: undefined, absent: null };
  await web.request('POST', LOGIN, form, headers);
  assert.equal(calls.length, 1);
  const [url, options] = calls[0];
  assert.equal(url, 'https://katalk.kakao.com/win32/account/login.json');
  assert.equal(web.url, 'https://katalk.kakao.com');
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'error');
  assert.deepEqual(options.headers, { ...headers, 'content-type': 'application/x-www-form-urlencoded' });
  assert.ok(options.body instanceof URLSearchParams);
  assert.deepEqual(Object.fromEntries(options.body), { email: EMAIL, password: PASSWORD,
    device_uuid: 'synthetic-device', forced: 'false', device_name: 'OpenTalk Welcome Server' });
  assert.equal(new URLSearchParams(options.body.toString()).get('password'), PASSWORD);
  assert.equal(options.signal.aborted, false);
  assert.equal(form.forced, false);
  assert.equal(Object.hasOwn(headers, 'content-type'), false);
});

test('passcode requests and permanent registration use only their explicit endpoint and submitted fields', async () => {
  const { web, calls } = fixture(() => response());
  await web.request('POST', 'win32/account/request_passcode.json', FORM);
  await web.request('POST', 'win32/account/register_device.json', { ...FORM, passcode: '012345', permanent: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], 'https://katalk.kakao.com/win32/account/request_passcode.json');
  assert.equal(calls[0][1].body.has('passcode'), false);
  assert.equal(calls[1][0], 'https://katalk.kakao.com/win32/account/register_device.json');
  assert.equal(calls[1][1].body.get('passcode'), '012345');
  assert.equal(calls[1][1].body.get('permanent'), 'true');
  assert.equal(calls[1][1].body.get('forced'), 'false');
});

test('other methods, origins, paths and multipart requests are rejected before fetch', async () => {
  const { web, calls } = fixture();
  for (const [method, path] of [['GET', LOGIN], ['post', LOGIN],
    ['POST', 'https://example.invalid/win32/account/login.json'],
    ['POST', '//example.invalid/win32/account/login.json'], ['POST', '../account/login.json'],
    ['POST', 'win32/account/login.json?next=elsewhere'], ['POST', 'win32/account/logout.json']]) {
    await rejectsCode(web.request(method, path, FORM), 'AUTH_ENDPOINT_REJECTED');
  }
  await rejectsCode(web.requestMultipart('POST', LOGIN, FORM), 'AUTH_ENDPOINT_REJECTED');
  assert.equal(calls.length, 0);
});

test('non-success JSON exposes only bounded numeric HTTP and API statuses', async () => {
  for (const [http, apiStatus] of [[400, -100], [403, 12], [429, -20], [500, 0]]) {
    const { web } = fixture(response(JSON.stringify({ status: apiStatus, email: EMAIL,
      message: PASSWORD, accessToken: TOKEN }), http));
    await rejectsCode(web.request('POST', LOGIN, FORM), `AUTH_HTTP_${http}_STATUS_${apiStatus}`);
  }
});

test('HTML and other error bodies cannot leak response content or status text', async () => {
  for (const body of [`<html>${EMAIL} ${PASSWORD} ${TOKEN}</html>`, 'not JSON', '']) {
    const { web } = fixture(new Response(body, { status: 403, statusText: TOKEN }));
    await rejectsCode(web.request('POST', LOGIN, FORM), 'AUTH_HTTP_403');
  }
});

test('untrusted string, fractional, nested, array and out-of-range statuses are omitted from errors', async () => {
  const values = [PASSWORD, TOKEN, '-100', 1.5, 1_000_000_001, -1_000_000_001,
    null, { status: -100 }, [-100]];
  for (const status of values) {
    const { web } = fixture(response(JSON.stringify({ status }), 400));
    await rejectsCode(web.request('POST', LOGIN, FORM), 'AUTH_HTTP_400');
  }
  for (const body of ['[{"status":-100}]', '{"status":1e999}', 'null']) {
    const { web } = fixture(response(body, 400));
    await rejectsCode(web.request('POST', LOGIN, FORM), 'AUTH_HTTP_400');
  }
  const { web } = fixture({ ok: false, status: TOKEN, body: (async function* () { yield Buffer.from('{}'); })() });
  await rejectsCode(web.request('POST', LOGIN, FORM), 'AUTH_HTTP_ERROR');
});

test('successful large numeric IDs and split UTF-8 bytes reach the lossless caller unchanged', async () => {
  const raw = Buffer.from(' {"status":0,"userId":9223372036854775807,"name":"환영"}\n');
  const split = raw.indexOf(Buffer.from('환')) + 1;
  const { web } = fixture({ status: 200, ok: true,
    body: (async function* () { yield raw.subarray(0, split); yield raw.subarray(split); })() });
  const result = await web.request('POST', LOGIN, FORM);
  assert.ok(result instanceof ArrayBuffer);
  assert.deepEqual(Buffer.from(result), raw);
  assert.ok(Buffer.from(result).toString().includes('9223372036854775807'));
});

test('HTTP success still requires a valid numeric API status', async () => {
  for (const body of ['<html>upstream</html>', '{', '{}', 'null', '[]', '{"status":"0"}',
    '{"status":1.5}', '{"status":1000000001}']) {
    const { web } = fixture(response(body));
    await rejectsCode(web.request('POST', LOGIN, FORM), 'AUTH_RESPONSE_INVALID');
  }
});

test('the 64 KiB response limit accepts its boundary and closes an oversized success stream', async () => {
  const prefix = '{"status":0}';
  const exact = Buffer.from(prefix + ' '.repeat(65536 - Buffer.byteLength(prefix)));
  const { web } = fixture(response(exact));
  assert.equal((await web.request('POST', LOGIN, FORM)).byteLength, 65536);
  let advanced = 0, closed = false;
  const oversized = fixture({ status: 200, ok: true, body: (async function* () {
    try { advanced++; yield exact; advanced++; yield Buffer.from(' '); advanced++; yield Buffer.from(TOKEN); }
    finally { closed = true; }
  })() }).web;
  await rejectsCode(oversized.request('POST', LOGIN, FORM), 'AUTH_RESPONSE_TOO_LARGE');
  assert.equal(advanced, 2);
  assert.equal(closed, true);
});

test('oversized HTTP failures stop reading and retain only their HTTP code', async () => {
  let closed = false, advanced = 0;
  const { web } = fixture({ status: 413, ok: false, body: (async function* () {
    try { advanced++; yield Buffer.alloc(65537, 32); advanced++; yield Buffer.from(TOKEN); }
    finally { closed = true; }
  })() });
  await rejectsCode(web.request('POST', LOGIN, FORM), 'AUTH_HTTP_413');
  assert.equal(advanced, 1);
  assert.equal(closed, true);
});

test('connection exceptions and their private causes are replaced with a safe code', async () => {
  for (const error of [new Error(`${EMAIL} ${PASSWORD}`, { cause: new Error(TOKEN) }),
    new TypeError(TOKEN), new DOMException(PASSWORD, 'AbortError')]) {
    const { web } = fixture(() => { throw error; });
    await rejectsCode(web.request('POST', LOGIN, FORM), 'AUTH_CONNECTION_FAILED');
  }
});

test('interrupted response streams are sanitized on both HTTP success and failure', async () => {
  for (const [status, code] of [[200, 'AUTH_CONNECTION_FAILED'], [502, 'AUTH_HTTP_502']]) {
    let closed = false;
    const { web } = fixture({ status, ok: status === 200, body: (async function* () {
      try { yield Buffer.from('{"status":'); throw new Error(`${TOKEN} ${PASSWORD}`); }
      finally { closed = true; }
    })() });
    await rejectsCode(web.request('POST', LOGIN, FORM), code);
    assert.equal(closed, true);
  }
});

test('caller abort reaches fetch and cannot expose the private abort reason', async () => {
  const controller = new AbortController();
  let observedSignal;
  const web = createWelcomeAuthWeb({ signal: controller.signal, fetchImpl: async (_url, options) => {
    observedSignal = options.signal;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
  } });
  const pending = web.request('POST', LOGIN, FORM);
  controller.abort(new Error(TOKEN));
  await rejectsCode(pending, 'AUTH_CONNECTION_FAILED');
  assert.equal(observedSignal.aborted, true);
});

test('the configured timeout aborts a waiting fetch without exposing fetch errors', async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  let timedOut = false;
  try {
    const web = createWelcomeAuthWeb({ timeoutMs: 5, fetchImpl: async (_url, { signal }) =>
      new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
        timedOut = signal.reason?.name === 'TimeoutError';
        reject(new Error(TOKEN));
      }, { once: true })) });
    await rejectsCode(web.request('POST', LOGIN, FORM), 'AUTH_CONNECTION_FAILED');
    assert.equal(timedOut, true);
  } finally { clearTimeout(keepAlive); }
});

test('modern Windows approval uses pinned JSON routes and preserves the original device and login headers', async () => {
  const {web,calls}=fixture((_url,options)=>response(JSON.stringify(options.body.includes('permanent')
    ? {status:0,passcode:'01234567',remainingSeconds:120,accessToken:TOKEN}
    : {status:-100,remainingSeconds:116,nextRequestIntervalInSeconds:4})));
  const headers={A:'win32/26.4.0/ko','X-VC':'synthetic-xvc'};
  const logins=[];
  const base={name:'Test Welcome',deviceUUID:'synthetic-uuid',config:{deviceModel:'',osVersion:'10.0'},
    createAuthHeader:async form=>{assert.equal(form.email,EMAIL);return headers},
    login:async(...args)=>{logins.push(args);return {status:-100,success:false}}};
  const api=createWelcomePasscodeApi({api:base,web});
  const challenge=await api.generatePasscode(FORM);
  const pending=await api.pollPasscode(FORM);
  assert.deepEqual(challenge,{status:0,success:true,result:{passcode:'01234567',remainingSeconds:120}});
  assert.deepEqual(pending,{status:-100,success:false,result:{remainingSeconds:116,nextRequestIntervalInSeconds:4}});
  assert.deepEqual(calls.map(c=>c[0]),['https://katalk.kakao.com/win32/account/passcodeLogin/generate','https://katalk.kakao.com/win32/account/passcodeLogin/registerDevice']);
  assert.deepEqual(JSON.parse(calls[0][1].body),{email:EMAIL,password:PASSWORD,permanent:true,
    device:{name:'Test Welcome',uuid:'synthetic-uuid',model:'',osVersion:'10.0',isOneStore:false}});
  assert.deepEqual(JSON.parse(calls[1][1].body),{email:EMAIL,password:PASSWORD,device:{uuid:'synthetic-uuid'}});
  for(const [,options] of calls){assert.equal(options.headers['content-type'],'application/json');assert.equal(options.headers['X-VC'],headers['X-VC']);assert.equal(options.redirect,'error')}
  await api.login(FORM,false);assert.deepEqual(logins,[[FORM,false]]);
});

test('modern JSON transport rejects unsupported routes before sending credentials',async()=>{
  const {web,calls}=fixture();
  for(const path of ['https://example.invalid/win32/account/passcodeLogin/generate','win32/account/passcodeLogin/generate?next=other','android/account/passcodeLogin/generate','win32/account/login.json','win32/account/passcodeLogin/authorize']){
    await rejectsCode(web.requestJson(path,FORM),'AUTH_ENDPOINT_REJECTED');
  }
  assert.equal(calls.length,0);
});

test('modern JSON requests abort with the login attempt and sanitize response errors',async()=>{
  const controller=new AbortController();let observed;
  const web=createWelcomeAuthWeb({fetchImpl:async(_url,{signal})=>{observed=signal;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error(PASSWORD)),{once:true}))}});
  const pending=web.requestJson('win32/account/passcodeLogin/generate',FORM,{}, {signal:controller.signal});
  controller.abort();await rejectsCode(pending,'AUTH_CONNECTION_FAILED');assert.equal(observed.aborted,true);
  const failed=fixture(response(JSON.stringify({status:-400,message:PASSWORD}),400)).web;
  await rejectsCode(failed.requestJson('win32/account/passcodeLogin/registerDevice',FORM),'AUTH_HTTP_400_STATUS_-400');
});

test('transport-owned error instances cannot leak private abort reasons or custom stacks',async()=>{
  for(const error of [new WelcomeError(TOKEN),Object.assign(new WelcomeError('AUTH_HTTP_404'),{stack:TOKEN})]){
    const controller=new AbortController();
    const web=createWelcomeAuthWeb({fetchImpl:async(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))});
    const pending=web.requestJson('win32/account/passcodeLogin/generate',FORM,{}, {signal:controller.signal});
    controller.abort(error);
    await rejectsCode(pending,error.code==='AUTH_HTTP_404'?'AUTH_HTTP_404':'AUTH_CONNECTION_FAILED');
  }
});

test('malformed approval timing is rejected instead of being treated as an absent polling interval',async()=>{
  for(const body of [{status:-100,nextRequestIntervalInSeconds:'60'},{status:0,remainingSeconds:{secret:TOKEN}}]){
    const {web}=fixture(response(JSON.stringify(body)));
    const api=createWelcomePasscodeApi({api:{deviceUUID:'synthetic-uuid',createAuthHeader:async()=>({})},web});
    await rejectsCode(api.pollPasscode(FORM),'AUTH_RESPONSE_INVALID');
  }
});
