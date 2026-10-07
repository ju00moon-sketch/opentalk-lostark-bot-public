import test from 'node:test';
import assert from 'node:assert/strict';
import {createHoningService} from '../src/honing-service.js';
import {HONING_MODEL} from '../../src/data/honing-valuation.js';

const rows=[['운명의 파괴석',100,100],['운명의 수호석',100,100],['운명의 돌파석',1,1],
  ['아비도스 융화 재료',1,1],['운명의 파편 주머니(대)',6000,2],['용암의 숨결',2,1],
  ['빙하의 숨결',2,1],['야금술 : 업화 [19-20]',3,1],['재봉술 : 업화 [19-20]',3,1]]
  .map(([name,currentMinPrice,bundleCount])=>({name,currentMinPrice,bundleCount}));
const setup=(options={})=>{let calls=0;let clock=1790000000000;const market={search:async()=>{calls++;return {items:rows,pageSize:100,totalCount:rows.length};}};
  return {service:createHoningService({market,now:()=>clock,...options}),calls:()=>calls,advance:()=>clock+=1000};};

test('웹 성공 응답은 기존 수치와 새 상세·단가 출처를 함께 제공한다',async()=>{
  const h=setup();const r=await h.service.get({kind:'weapon',from:0,to:1});h.service.close();
  assert.ok(r.details);assert.equal(r.expectedGold,4147);assert.equal(r.details.totals.expectedGold,r.expectedGold);
  assert.equal(r.stages[0].plan,undefined);assert.ok(r.stages[0].details.plan);
  assert.equal(r.details.model.artisanCoefficient,HONING_MODEL.artisan.coefficient);
  assert.equal(r.details.model.artisanResolution,HONING_MODEL.artisan.resolution);
  const shard=r.details.prices.find(p=>p.name==='운명의 파편');
  assert.deepEqual(shard,{name:'운명의 파편',unit:'item',unitGold:1,source:'shard_bag',sourceItemName:'운명의 파편 주머니(대)',sourceBundleCount:2,sourceBundleGold:6000,divisor:6000});
  assert.equal(r.details.pricedAt,r.pricedAt);assert.equal(r.details.planDelivery,'complete');
});

test('상세 시세 캐시는 기존 호출 횟수와 시점을 유지한다',async()=>{
  const h=setup();const first=await h.service.get({kind:'weapon',from:18,to:20});const count=h.calls();h.advance();
  const next=await h.service.get({kind:'armor',from:18,to:20});h.service.close();
  assert.ok(first.details);assert.equal(h.calls(),count);assert.equal(next.pricedAt,first.pricedAt);
  assert.equal(next.details.pricedAt,next.pricedAt);assert.ok(next.updatedAt>next.pricedAt);
});

test('크기 상한이면 전체 회차만 생략하고 집계·기존 구간은 보존한다',async()=>{
  const h=setup();const full=await h.service.get({kind:'weapon',from:18,to:20});h.service.close();assert.ok(full.details);
  const without=structuredClone(full);for(const s of without.stages)s.details.plan=null;without.details.planDelivery='omitted_size_limit';
  const limit=Buffer.byteLength(JSON.stringify(without))+100;
  assert.ok(limit<Buffer.byteLength(JSON.stringify(full)));
  const small=setup({maxResponseBytes:limit});const r=await small.service.get({kind:'weapon',from:18,to:20});small.service.close();
  assert.equal(r.details.planDelivery,'omitted_size_limit');assert.ok(r.stages.every(s=>s.details.plan===null));
  assert.deepEqual(r.stages.map(s=>s.details.materials),full.stages.map(s=>s.details.materials));
  assert.deepEqual(r.stages.map(s=>s.segments),full.stages.map(s=>s.segments));
  assert.ok(Buffer.byteLength(JSON.stringify(r))<=limit);
  const tiny=setup({maxResponseBytes:1});await assert.rejects(()=>tiny.service.get({kind:'weapon',from:0,to:1}),/honing_unavailable/);tiny.service.close();
});

test('전 구간 기본 응답은 상한 안에 있고 새 필드에 비유한 수가 없다',async()=>{
  const h=setup();const r=await h.service.get({kind:'armor',from:0,to:25});h.service.close();assert.ok(r.details);
  assert.ok(Buffer.byteLength(JSON.stringify(r))<=1048576);
  const visit=value=>{if(typeof value==='number')assert.ok(Number.isFinite(value));else if(value&&typeof value==='object')for(const v of Object.values(value))visit(v);};visit(r);
  assert.equal(r.details.totals.maximumAttempts,r.stages.reduce((n,s)=>n+s.maximumAttempts,0));
  assert.ok(r.stages.every(s=>s.details.percentiles.map(p=>p.probability).join(',')==='0.5,0.9'));
});
