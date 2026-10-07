import test from 'node:test';
import assert from 'node:assert/strict';
import {createBraceletValueService} from '../src/bracelet-value.js';
import {analyzeBraceletExpectation} from '../../src/character-bracelet-expectation.js';
import {createBraceletValueRecordStore} from '../src/bracelet-value-record-store.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const NOW=Date.parse('2026-09-16T06:00:00Z');
const POLICY='bracelet-three-reconversion-v2:bounded-combat-v1:log2sd-v1';
const config={automaticApproval:{lostArkApiKey:'synthetic-record'}};
const name='시험캐릭터';
const equipment={Type:'팔찌',Grade:'고대',Tooltip:JSON.stringify({
 title:{type:'ItemTitle',value:{leftStr2:'아이템 티어 4'}},
 effects:{type:'ItemPartBox',value:{Element_000:'팔찌 효과',Element_001:[['locked','치명 +83'],['locked','특화 +90'],['changeable','민첩 +12000'],['changeable','체력 +5000']].map(([kind,text])=>`<img src='emoticon_tooltip_bracelet_${kind}'></img>${text}`).join('<BR>')}}})};
const expectation=analyzeBraceletExpectation({ArmoryEquipment:[equipment]});
const details=()=>({efficiency:{source:'official-api',characterName:name,braceletExpectation:structuredClone(expectation)}});
const previous=(basePriceGold=200,recordedAt=NOW-10000)=>({characterName:name,targetKey:expectation.targetKey,policyVersion:POLICY,
 costExpectedGold:basePriceGold*expectation.expectedStartingBracelets,recordedAt,basePriceGold,
 expectedStartingBracelets:expectation.expectedStartingBracelets,successProbability:expectation.successProbability,
 expectedReconversionTicketsUntilSuccess:expectation.expectedReconversionTicketsUntilSuccess});
const page=(price=100)=>({PageNo:1,PageSize:10,TotalCount:price===null?0:1,Items:price===null?[]:[{
 Name:'고대 팔찌',Tier:4,Grade:'고대',AuctionInfo:{BuyPrice:price,TradeAllowCount:0,EndDate:'2026-09-17T12:00:00Z'},Options:[
  {Type:'STAT',OptionName:'치명',Value:83,IsValuePercentage:false},
  {Type:'STAT',OptionName:'특화',Value:90,IsValuePercentage:false},
  {Type:'BRACELET_RANDOM_SLOT',OptionName:'부여 효과 수량',Value:2,IsValuePercentage:false},
 ]}]});
const answer=value=>Response.json(value);
function recordStore(initial=null){let record=initial;const writes=[],reads=[];return {writes,reads,get:(...args)=>{reads.push(args);return record&&structuredClone(record);},record:(characterName,targetKey,policyVersion,value)=>{writes.push(structuredClone(value));if(!record||value.costExpectedGold>record.costExpectedGold)record={characterName,targetKey,policyVersion,...value};return structuredClone(record);}};}
function service(overrides={}){return createBraceletValueService({config,now:()=>NOW,cacheMs:0,readDetails:async()=>details(),fetchImpl:async()=>answer(page()),...overrides});}

test('current quote and monotonic record remain separate and ties retain the original timestamp',async t=>{
 const store=recordStore();let price=100,clock=NOW;
 const app=service({recordStore:store,now:()=>clock,fetchImpl:async()=>answer(page(price))});t.after(()=>app.close());
 const first=await app.get(name);assert.equal(first.recordStatus,'saved');assert.equal(first.record.recordedAt,NOW);
 assert.deepEqual(store.reads[0],[name,expectation.targetKey,POLICY]);
 assert.equal(first.record.costExpectedGold,first.costExpectedGold);assert.equal(first.record.basePriceGold,100);
 clock+=100;price=50;const lower=await app.get(name);assert.equal(lower.price.meanGold,50);assert.equal(lower.costExpectedGold,first.costExpectedGold/2);assert.deepEqual(lower.record,first.record);
 clock+=100;price=100;assert.deepEqual((await app.get(name)).record,first.record);
 clock+=100;price=300;const higher=await app.get(name);assert.equal(higher.record.recordedAt,clock);assert.equal(higher.record.costExpectedGold,first.costExpectedGold*3);
 higher.record.basePriceGold=1;assert.equal((await app.get(name)).record.basePriceGold,300);
});
test('no listings rate limits and transport failures preserve a verified old record without writing',async t=>{
 for(const mode of ['empty','rate','transport','invalid']){
  const old=previous(),store=recordStore(old),app=service({recordStore:store,fetchImpl:async()=>{
    if(mode==='transport')throw new Error('offline');if(mode==='rate')return new Response('',{status:429});
    const body=page(mode==='empty'?null:100);if(mode==='invalid')body.PageNo=2;return answer(body);
  }});t.after(()=>app.close());
  const result=await app.get(name);assert.equal(result.status,mode==='empty'?'no_listings':'unavailable');
  assert.equal(result.recordStatus,'saved');assert.deepEqual(result.record,old);assert.equal(result.costExpectedGold,null);assert.equal(store.writes.length,0);
  if(mode==='rate')assert.equal(result.currentErrorCode,'bracelet_value_rate_limited');
 }
});
test('storage failures do not hide current price and cannot pretend it was recorded',async t=>{
 for(const phase of ['read','write','both']){
  const old=previous(),store=recordStore(old);if(phase!=='write')store.get=()=>{throw new Error('store unavailable');};
  store.record=()=>{throw new Error('disk full');};
  const app=service({recordStore:store});t.after(()=>app.close());const result=await app.get(name);
  assert.equal(result.status,'ok');assert.equal(result.price.meanGold,100);assert.equal(result.recordStatus,'unavailable');
  assert.deepEqual(result.record,phase==='write'?old:null);
 }
 for(const recordStore of [undefined,null]){const app=service({recordStore});t.after(()=>app.close());const r=await app.get(name);assert.equal(r.status,'ok');assert.equal(r.recordStatus,recordStore===undefined?'none':'unavailable');assert.equal(r.record,null);}
});
test('a record must match the current identity target policy and three-ticket calculation',async t=>{
 for(const change of [r=>r.characterName='다른사람',r=>r.targetKey='a'.repeat(64),r=>r.policyVersion='bracelet-no-reconversion-v1',
   r=>r.expectedStartingBracelets*=2,r=>r.successProbability=.99,r=>r.expectedReconversionTicketsUntilSuccess*=2,
   r=>r.costExpectedGold+=100,r=>r.recordedAt=NOW+1]){
  const old=previous();change(old);const store=recordStore(old),app=service({recordStore:store,fetchImpl:async()=>answer(page(null))});t.after(()=>app.close());
  const result=await app.get(name);assert.equal(result.status,'no_listings');assert.equal(result.record,null);assert.equal(result.recordStatus,'unavailable');
 }
});
test('invalid details and a past zero-ticket snapshot cannot read or write a current record',async t=>{
 for(const change of [r=>r.efficiency.characterName='다른사람',r=>r.efficiency.braceletExpectation.scenarios[0].reconversionTickets=0]){
  const store=recordStore(previous()),app=service({recordStore:store,readDetails:async()=>{const r=details();change(r);return r;}});t.after(()=>app.close());
  await assert.rejects(app.get(name),{status:502});assert.equal(store.reads.length,0);assert.equal(store.writes.length,0);
 }
});
test('timeouts may show an already read record but late transport completion and close never write',async()=>{
 for(const close of [false,true]){
  let release,entered;const started=new Promise(r=>entered=r),store=recordStore(previous());
  const app=service({recordStore:store,operationTimeoutMs:30,requestTimeoutMs:1000,fetchImpl:()=>{entered();return new Promise(r=>release=()=>r(answer(page(500))));}});
  const result=app.get(name).catch(e=>e);await started;if(close)app.close();
  const value=await result;if(close)assert.equal(value.status,503);else{assert.equal(value.status,'unavailable');assert.equal(value.recordStatus,'saved');assert.deepEqual(value.record,previous());}
  release();await new Promise(r=>setTimeout(r,5));assert.equal(store.writes.length,0);app.close();
 }
});
test('the service round-trips its exact three-ticket DTO through the durable store after restart',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'bracelet-record-service-')),file=join(directory,'records.sqlite');
 let store=createBraceletValueRecordStore(file,{now:()=>NOW}),app=service({recordStore:store});
 t.after(()=>{app.close();store.close();rmSync(directory,{recursive:true,force:true});});
 const first=await app.get(name);assert.equal(first.recordStatus,'saved');assert.equal(first.record.costExpectedGold,first.costExpectedGold);
 app.close();store.close();store=createBraceletValueRecordStore(file,{now:()=>NOW});app=service({recordStore:store,fetchImpl:async()=>answer(page(null))});
 const restored=await app.get(name);assert.equal(restored.status,'no_listings');assert.equal(restored.recordStatus,'saved');assert.deepEqual(restored.record,first.record);
});
