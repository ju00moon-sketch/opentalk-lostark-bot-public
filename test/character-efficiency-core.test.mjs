import test from 'node:test';
import assert from 'node:assert/strict';

// Only this test's synthetic source is ever downloaded. No environment file is loaded.
delete process.env.LOPEC_SANDBOX_WRAPPER;
delete process.env.LOSTARK_API_KEY;
const requests = [];
const source = `({123:(e,r,t)=>{var n=t(234),s=t(567);let x={banglePercent:(0,n.l)(p)};if(p.profile.supportCheck){}else{let t=(0,s.cA)(p);m.arkgridPercent=t.efficiency}},
234:(e,r,t)=>{t.d(r,{l:()=>a});var b=t(345),s=t(456);function a(e){if(e.profile.supportCheck){return(0,s.su)(e).efficiency}let a={};return(0,b.bp)(e,a)}},
345:(e,r,t)=>{t.d(r,{bp:()=>b});function b(p,a){if(p.profile.nickName.includes("지연")){let start=Date.now();while(Date.now()-start<180){}}return 15.62}},
456:(e,r,t)=>{t.d(r,{su:()=>b});function b(p){return {efficiency:11.5}}},
567:(e,r,t)=>{t.d(r,{cA:()=>g});function g(p){return {efficiency:9.41,optionEfficiency:2.2,pointEfficiency:7.05,effectEfficiencies:[{name:"추가 피해",level:5,effect:2.5,efficiency:0}]}}}}) `;
const chunkPath = '/_next/static/chunks/app/(desktop)/character/%5Bname%5D/fixture.js';
const html = (name, support) => `<script src="${chunkPath}"></script><script>self.__next_f.push([1,${JSON.stringify(JSON.stringify({ lostarkParser: { profile: { nickName: name, supportCheck: support } } }))}])</script>`;
globalThis.fetch = async (url, init) => {
  assert.equal(new URL(url).origin, 'https://lopec.kr'); assert.equal(init.redirect, 'error');
  requests.push(new URL(url).pathname);
  if (new URL(url).pathname === chunkPath) return new Response(source);
  if (new URL(url).pathname.startsWith('/character/specPoint/')) {
    const name = decodeURIComponent(new URL(url).pathname.split('/').at(-1));
    return new Response(html(name === '이름불일치' ? '다른캐릭터' : name, name.includes('서포터')));
  }
  throw new Error('Unexpected external request');
};
const { createLopecTextFetcher } = await import('../src/lopec.js');
const { getBanglePercent, getArkgridEfficiency, __test } = await import('../src/lopec-sim.js');
const { createCharacterEfficiencyServer } = await import('../src/character-efficiency-server.js');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('existing dealer/support calculations execute synthetic modules in the real restricted child', async () => {
  const before = requests.length;
  const values = await Promise.all([getBanglePercent('딜러테스트'), getBanglePercent('딜러테스트'), getArkgridEfficiency('딜러테스트')]);
  assert.deepEqual(values.slice(0, 2), [15.62, 15.62]); assert.equal(values[2].efficiency, 9.41);
  assert.equal(values[2].effectEfficiencies[0].efficiency, 0);
  assert.equal(requests.slice(before).filter(path => path.startsWith('/character/')).length, 1);
  assert.equal(requests.slice(before).filter(path => path.includes('fixture.js')).length, 1);
  assert.equal(await getBanglePercent('서포터테스트'), 11.5);
  assert.equal(await getArkgridEfficiency('서포터테스트'), null);
  assert.equal(await getBanglePercent('이름불일치'), null);
  assert.equal(await getArkgridEfficiency('이름불일치'), null);
});

test('default companion preserves calculated values and a definite unsupported support gem', async t => {
  const service = createCharacterEfficiencyServer({ config: { url: 'http://127.0.0.1:52999', token: 'x'.repeat(43) } });
  t.after(() => service.close());
  const dealer = await service.get('딜러테스트'); assert.equal(dealer.bracelet.efficiency, 15.62); assert.equal(dealer.gem.efficiency, 9.41);
  const support = await service.get('서포터테스트'); assert.equal(support.bracelet.efficiency, 11.5); assert.equal(support.gem.status, 'unsupported');
});

test('one cancelled consumer cannot abort the bot sharing the same character calculation', async () => {
  const controller = new AbortController();
  const cancelled = getBanglePercent('지연공유테스트', { signal: controller.signal });
  const survivor = getBanglePercent('지연공유테스트');
  const rejected = assert.rejects(cancelled, /expired/);
  await delay(60); controller.abort(); await rejected;
  assert.equal(await survivor, 15.62);
  assert.equal(requests.filter(path => decodeURIComponent(path).endsWith('/지연공유테스트')).length, 1);
  const alone = new AbortController();
  const task = getBanglePercent('지연취소테스트', { signal: alone.signal });
  const failed = assert.rejects(task, /expired/);
  await delay(60); alone.abort(); await failed; await delay(30);
  assert.equal(await getBanglePercent('지연취소테스트'), 15.62);
});

test('restricted child cannot reach process/network/code generation and an expired child releases its slot', async () => {
  const script = `({bangle:()=>JSON.stringify({process:typeof process,fetch:typeof fetch,WebSocket:typeof WebSocket,generated:(()=>{try{Function('return 1')();return true}catch{return false}})()})})`;
  assert.deepEqual(await __test.runInSandbox(script, 'bangle', '{}'), { process: 'undefined', fetch: 'undefined', WebSocket: 'undefined', generated: false });
  await assert.rejects(__test.runInSandbox('({bangle:()=>{while(true){}}})', 'bangle', '{}', { timeoutMs: 100 }), /시간 초과/);
  assert.equal(await __test.runInSandbox('({bangle:()=>"7"})', 'bangle', '{}'), 7);
});

test('one limiter accounts actual running tasks, rejects excess and removes timed-out/aborted waiters', async () => {
  const limit = __test.createLimiter(1, { maxWaiting: 1, waitMs: 25 });
  let release;
  const first = limit(() => new Promise(resolve => { release = resolve; }));
  const queued = limit(async () => 2); const queuedFailure = assert.rejects(queued, /expired/);
  await assert.rejects(limit(async () => 3), /full/); await queuedFailure;
  const controller = new AbortController(); const aborted = limit(async () => 4, { signal: controller.signal });
  controller.abort(); await assert.rejects(aborted, /expired/);
  release(1); assert.equal(await first, 1); assert.equal(await limit(async () => 5), 5);
});

test('source transport bounds bytes, redirects, malformed UTF-8 and source origins', async () => {
  for (const response of [new Response('x'.repeat(65)), new Response('ok', { headers: { 'content-length': '65' } }), new Response(new Uint8Array([0xff]))]) {
    const read = createLopecTextFetcher({ maxBytes: 64, fetchImpl: async () => response });
    await assert.rejects(read('https://lopec.kr/character/specPoint/test'));
  }
  let calls = 0;
  const read = createLopecTextFetcher({ fetchImpl: async (_url, init) => { calls++; assert.equal(init.redirect, 'error'); return new Response('ok'); } });
  for (const url of ['https://other.invalid/', 'http://lopec.kr/', 'https://maintainer@example.com/', 'https://lopec.kr/#x']) await assert.rejects(read(url));
  assert.equal(calls, 0); assert.equal(await read('https://lopec.kr/test'), 'ok');
});

test('source queue and full network/body deadline are enforced without external access', async () => {
  const finishes = [];
  const read = createLopecTextFetcher({ concurrency: 1, maxWaiting: 1, timeoutMs: 40,
    fetchImpl: async (_url, init) => new Promise((resolve, reject) => { finishes.push(resolve); init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); }) });
  const first = read('https://lopec.kr/first'), second = read('https://lopec.kr/second');
  const failures = Promise.all([assert.rejects(first), assert.rejects(second)]);
  await assert.rejects(read('https://lopec.kr/third'), /full/); await failures;
  // The second request may acquire the released slot just before its own deadline.
  assert(finishes.length >= 1 && finishes.length <= 2);
  await assert.rejects(__test.ensureRuntime(Array.from({ length: 65 }, (_, i) => `<script src="/_next/static/chunks/${i}.js"></script>`).join('')), /Invalid/);
  for (const path of ['/_next/static/chunks/%2e%2e/private.js', '/_next/static/chunks/%2F%2E%2E%2Fprivate.js', '/_next/static/chunks/bad%GG.js']) {
    await assert.rejects(__test.ensureRuntime(`<script src="${path}"></script>`), /Invalid/);
  }
});
