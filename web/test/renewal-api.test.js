import { approvedRequester } from './helpers/access.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createWebServer } from '../src/server.js';
import { createOfficialBudget } from '../src/official-budget.js';
import { createLoungeService } from '../src/lounge-service.js';

const keyConfig = { automaticApproval: { lostArkApiKey: 'synthetic-only' } };
const official = 'https://developer-lostark.game.onstove.com';

test('one web allowance spans endpoints but does not consume OAuth capacity', async () => {
  let now = 0, calls = 0;
  const wrapped = createOfficialBudget({ now: () => now, perMinute: 2, fetchImpl: async () => { calls++; return Response.json([]); } });
  await wrapped(official + '/news/events'); await wrapped(official + '/markets/items');
  await assert.rejects(wrapped(official + '/armories/characters/name'), { status: 429 });
  await wrapped('https://discord.com/api/oauth2/token'); assert.equal(calls, 3);
  now = 60001; await wrapped(official + '/news/events'); assert.equal(calls, 4);
});

test('observed reserve is conservative across out of order replies and honors reset', async () => {
  let now = 1790000000000, remaining = 17;
  const wrapped = createOfficialBudget({ now: () => now, fetchImpl: async () => Response.json([], { headers: { 'x-ratelimit-remaining': String(remaining) } }) });
  await wrapped(official + '/news/notices'); remaining = 90;
  await wrapped(official + '/news/events'); await wrapped(official + '/gamecontents/calendar');
  await assert.rejects(wrapped(official + '/markets/items'), { status: 429 });
  now += 60001; await wrapped(official + '/markets/items');
});

test('lounge shares inflight reads and maps strict official URLs and Korea timestamps', async t => {
  let calls = 0;
  const service = createLoungeService({ config: keyConfig, fetchImpl: async () => { calls++; return Response.json([
    { Title: '<b>점검</b>', Type: '공지', Date: '2026-09-15T09:00:00', Link: 'https://lostark.game.onstove.com/News/Notice/Views/1' },
    { Title: 'unsafe', Date: '2026-09-15T09:00:00', Link: 'https://untrusted.invalid/private' },
  ]); } }); t.after(() => service.close());
  const [a,b] = await Promise.all([service.get('notices'), service.get('notices')]);
  assert.deepEqual(a,b); assert.equal(calls,1); assert.equal(a.items.length,1); assert.equal(a.items[0].title,'점검');
  assert.equal(a.items[0].date, Date.parse('2026-09-15T00:00:00Z'));
  await service.get('notices'); assert.equal(calls,1);
});

test('lounge rejects HTML, excessive bodies, invalid documents and upstream limits', async t => {
  for (const response of [new Response('<html>private</html>', { headers: {'content-type':'text/html'} }), Response.json({ private: 'not an array' }), new Response(' '.repeat(4*1024*1024+1), { headers:{'content-type':'application/json'} })]) {
    const service = createLoungeService({ config:keyConfig, fetchImpl:async()=>response }); t.after(()=>service.close());
    await assert.rejects(service.get('events'), {status:502,code:'lounge_unavailable'});
  }
  const service=createLoungeService({config:keyConfig,fetchImpl:async()=>Response.json({}, {status:429})}); t.after(()=>service.close());
  await assert.rejects(service.get('calendar'),{status:429,code:'lounge_rate_limited'});
});

test('approved renewal routes preserve origin, method, strict input and no-store contracts', async t => {
  const directory = await mkdtemp(join(tmpdir(),'web-renewal-test-'));
  const calls=[];
  const app=createWebServer({config:{...keyConfig,origin:'https://opentalk.example.invalid',host:'127.0.0.1',port:0,dbPath:join(directory,'auth.sqlite'),providers:{}},fetchImpl:async(url, init)=>{
    calls.push(new URL(url).pathname); assert.equal(init.redirect,'error');
    if(url.endsWith('/markets/options'))return Response.json({Categories:[{Code:50000,CodeName:'강화 재료',Subs:[{Code:50010,CodeName:'재련 재료'}]}]});
    if(url.endsWith('/markets/items'))return Response.json({PageNo:1,PageSize:10,TotalCount:1,Items:[{Id:123,Name:'운명의 파편',Grade:'희귀',Icon:'https://cdn-lostark.game.onstove.com/efui_iconatlas/test.png',BundleCount:1,CurrentMinPrice:10,YDayAvgPrice:12,RecentPrice:11}]});
    if(url.endsWith('/markets/items/123'))return Response.json([{Name:'운명의 파편',BundleCount:1,TradeRemainCount:0,Stats:[{Date:'2026-09-15',AvgPrice:10,TradeCount:20}]}]);
    return Response.json([]);
  }});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  const request=approvedRequester(join(directory,'auth.sqlite'));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  for(const path of ['/api/lounge?section=notices','/api/market/options','/api/market/search?q=운명의','/api/market/items/123/history','/api/market/bid?price=8800&partySize=4']){
    const response=await request(base+path);assert.equal(response.status,200,path);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('set-cookie'),null);
  }
  const bid=await (await request(base+'/api/market/bid?price=8800&partySize=4')).json();assert.equal(bid.preempt,5700);
  for(const path of ['/api/lounge?section=events&section=calendar','/api/lounge?section=bad','/api/market/search?q=x&q=y','/api/market/options?extra=1','/api/market/items/123/history?extra=1','/api/market/bid?price=1'])assert.equal((await request(base+path)).status,400,path);
  for(const path of ['/api/lounge?section=events','/api/market/options']){
    assert.equal((await request(base+path,{method:'POST'})).status,405);
    assert.equal((await request(base+path,{headers:{Origin:'https://untrusted.invalid'}})).status,403);
    assert.equal((await request(base+path,{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  }
});
