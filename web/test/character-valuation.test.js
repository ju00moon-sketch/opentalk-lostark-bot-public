import test from 'node:test';
import assert from 'node:assert/strict';
import { createCharacterValuationService, snapshotValuationInputs, VALUATION_INPUTS_VERSION } from '../src/character-valuation.js';
import { GuildError } from '../src/guild-store.js';

const timestamp=1790000000000, hash='a'.repeat(64);
const empty=()=>({status:'empty',items:[]});
function details(name) {
  return {updatedAt:timestamp,equipment:[],bracelet:null,arkgrid:{cores:[]},valuationTargets:{version:'roster-targets-v1',status:'ok',
    characterName:name,serverName:'루페온',observedAt:timestamp,targetKey:hash,quotes:[],
    components:Object.fromEntries(['gems','accessories','engravings','honing'].map(key=>[key,empty()]))}};
}
function setup(overrides={}) {
  return createCharacterValuationService({now:()=>timestamp,readDetails:async name=>details(name),
    readRoster:async()=>({roster:{characters:[{characterName:'다른캐릭터'},{characterName:'테스트바드'}]}}),
    prices:{get:async()=>{throw Error('unexpected quote');},gemCatalogue:async()=>{throw Error('unexpected catalogue');}},
    braceletValue:{get:async()=>{throw Error('unexpected bracelet');}},gemSolver:{get:async()=>{throw Error('unexpected solver');},close(){}},...overrides});
}
test('roster valuation advances one current-first character per poll and never counts pending as zero',async t=>{
  const calls=[];const service=setup({readDetails:async name=>{calls.push(name);return details(name);}});t.after(()=>service.close());
  const first=await service.get('테스트바드');assert.deepEqual(calls,['테스트바드']);
  assert.deepEqual(first.progress,{done:1,total:2});assert.equal(first.aggregate.totalGold,null);
  const last=await service.get('테스트바드');assert.equal(last.status,'done');assert.equal(last.aggregate.totalGold,0);
  assert.deepEqual(calls,['테스트바드','다른캐릭터']);
  await service.get('테스트바드');assert.equal(calls.length,2);
});
test('parallel polls share a character and throttled price work can resume',async t=>{
  let calls=0,limited=true,time=timestamp;
  const service=setup({now:()=>time,readDetails:async name=>{calls++;const data=details(name);data.valuationTargets.quotes=[{quoteKey:'q'}];return data;},
    prices:{get:async()=>{if(limited)throw Object.assign(Error('limited'),{status:429});return {status:'unavailable'};}}});t.after(()=>service.close());
  const [a,b]=await Promise.all([service.get('테스트바드','character'),service.get('테스트바드','character')]);
  assert.equal(calls,1);assert.equal(a.retryAfterSeconds,60);assert.deepEqual(a,b);assert.equal(a.progress.done,0);
  limited=false;
  assert.equal((await service.get('테스트바드','character')).retryAfterSeconds,60);assert.equal(calls,1);
  time+=60000;assert.equal((await service.get('테스트바드','character')).progress.done,1);
});

function deferred() {let resolve;return {promise:new Promise(done=>{resolve=done;}),resolve:value=>resolve(value)};}
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('short polls preserve and share a calculation until its later completion',async t=>{
  const blocked=deferred();let calls=0;
  const service=setup({operationTimeoutMs:500,pollTimeoutMs:20,readDetails:async name=>{calls++;await blocked.promise;return details(name);}});
  t.after(()=>{blocked.resolve();service.close();});
  const started=performance.now();
  const [a,b]=await Promise.all([service.get('테스트바드','character'),service.get('테스트바드','character')]);
  assert(performance.now()-started<250,'HTTP poll must finish before the calculation budget');
  assert.equal(calls,1);assert.equal(a.status,'running');assert.deepEqual(a.progress,{done:0,total:1});assert.deepEqual(a,b);
  assert.equal(a.characters[0].state,'pending');assert.equal(a.characters[0].value,null);assert.equal(a.aggregate.totalGold,null);
  assert.equal((await service.get('테스트바드','character')).status,'running');assert.equal(calls,1);
  blocked.resolve();const done=await service.get('테스트바드','character');assert.equal(done.status,'done');assert.equal(done.progress.done,1);
  assert.equal(done.characters[0].state,'done');assert.equal(calls,1);
});

test('a throttle arriving after the first poll persists its cooldown until a later poll can resume',async t=>{
  const blocked=deferred();let calls=0,limited=true,time=timestamp;
  const service=setup({operationTimeoutMs:500,pollTimeoutMs:20,now:()=>time,
    readDetails:async name=>{const data=details(name);data.valuationTargets.quotes=[{quoteKey:'q'}];return data;},
    prices:{get:async()=>{calls++;if(limited){await blocked.promise;throw Object.assign(Error('limited'),{status:429});}return {status:'unavailable'};}}});
  t.after(()=>{blocked.resolve();service.close();});
  const first=await service.get('테스트바드','character');assert.equal(first.status,'running');assert.equal(first.progress.done,0);
  blocked.resolve();await flush();
  const throttled=await service.get('테스트바드','character');assert.equal(throttled.retryAfterSeconds,60);assert.equal(throttled.characters[0].state,'pending');assert.equal(calls,1);
  time+=59000;assert.equal((await service.get('테스트바드','character')).retryAfterSeconds,1);assert.equal(calls,1);
  time+=1000;limited=false;
  const done=await service.get('테스트바드','character');assert.equal(done.status,'done');assert.equal(done.characters[0].state,'done');assert.equal(calls,2);
});

test('close rejects an outstanding poll and a late calculation cannot publish a result',async t=>{
  const blocked=deferred();let calls=0;
  const service=setup({operationTimeoutMs:500,pollTimeoutMs:20,readDetails:async name=>{calls++;await blocked.promise;return details(name);}});
  t.after(()=>{blocked.resolve();service.close();});
  assert.equal((await service.get('테스트바드','character')).status,'running');
  const waiting=service.get('테스트바드','character');await flush();service.close();
  await assert.rejects(waiting,{status:502});blocked.resolve();await flush();
  await assert.rejects(service.get('테스트바드','character'),{status:502});assert.equal(calls,1);
});

test('a hard calculation deadline settles only its row and retains the physical slot until late work exits',async t=>{
  const blocked=deferred(),other=deferred();const calls=[];
  const service=setup({operationTimeoutMs:80,pollTimeoutMs:20,
    readDetails:async name=>{calls.push(name);await(name==='테스트바드'?blocked.promise:other.promise);return details(name);}});
  t.after(()=>{blocked.resolve();other.resolve();service.close();});
  assert.equal((await service.get('테스트바드')).status,'running');
  let result;
  for(let attempt=0;attempt<10;attempt++){result=await service.get('테스트바드');if(result.characters[0].state==='error')break;}
  assert.equal(result.characters[0].state,'error');assert.equal(result.characters[0].value,null);assert.equal(result.characters[1].state,'pending');
  other.resolve();const done=await service.get('테스트바드');assert.equal(done.status,'done');assert.equal(done.characters[1].state,'done');
  assert.deepEqual(calls,['테스트바드','다른캐릭터']);
  const overlapping=await service.get('테스트바드','character');assert.equal(overlapping.characters[0].state,'error');assert.equal(calls.filter(name=>name==='테스트바드').length,1);
  blocked.resolve();await flush();
  const retained=await service.get('테스트바드');assert.equal(retained.characters[0].state,'error');assert.equal(retained.characters[1].state,'done');
});
test('honing recipes use a fresh price observation and missing equipment does not become an empty bracelet',async t=>{
  const service=setup({readDetails:async name=>{const data=details(name);data.equipment=null;
    data.valuationTargets.components.honing={status:'ok',items:[{id:'weapon',status:'ok',targetKey:hash}]};return data;},
    honingRecipe:()=>({status:'ok',targetKey:hash,modelVersion:'test-model',fixedGold:100,requirements:[{quoteKey:'q',quantity:2}],quotes:[{quoteKey:'q'}]}),
    prices:{get:async()=>({status:'ok',unitGold:50,checkedAt:timestamp-1000})}});t.after(()=>service.close());
  const data=(await service.get('테스트바드','character')).characters[0].value;
  assert.equal(data.components.honing.totalGold,200);assert.equal(data.components.bracelet.complete,false);
  assert.equal(data.totalGold,null);
});
test('bad scopes, duplicate roster identities and logout-style close return no result',async()=>{
  let release;const blocked=new Promise(resolve=>{release=resolve;});
  const service=setup({readDetails:async name=>{await blocked;return details(name);}});
  await assert.rejects(service.get('테스트바드','invalid'),{status:400});
  const waiting=service.get('테스트바드','character');await new Promise(resolve=>setImmediate(resolve));
  service.close();await assert.rejects(waiting);release();
  const bad=setup({readRoster:async()=>({roster:{characters:[{characterName:'테스트바드'},{characterName:'테스트바드'}]}})});
  await assert.rejects(bad.get('테스트바드'));bad.close();
});
test('missing gem target or price remains unknown; priced gem alternatives contribute expected cost',async t=>{
  const service=setup({readDetails:async name=>{const data=details(name);data.arkgrid.cores=[{name:'해의코어',gems:[
    {name:'질서의 젬 : 안정',target:{status:'ok',subtype:'안정',targetKey:hash}},
    {name:'질서의 젬 : 불변',target:{status:'unavailable'}}]}];return data;},
    prices:{gemCatalogue:async()=>({prices:{'안정:영웅':{status:'ok',unitGold:100,checkedAt:timestamp}}})},
    currency:{get:async()=>({status:'ok',pheonUnitGold:100})},
    gemSolver:{getBest:async(_target,options)=>{assert.equal(options.purchaseGoldByGrade.영웅,100);return {status:'ok',modelVersion:'test',alternatives:[{status:'ok',startingGrade:'영웅',expectedStartingGems:1,successProbability:1,purchaseGold:100,purchaseExpectedGold:100,processingExpectedGold:3700,totalExpectedGold:3800}]};},close(){}}});t.after(()=>service.close());
  const value=(await service.get('테스트바드','character')).characters[0].value;
  assert.equal(value.components.arkgridGems.knownGold,5000);assert.equal(value.components.arkgridGems.totalGold,null);
});
test('unknown core gem lists and a changed bracelet target stay outside the complete total',async t=>{
  const service=setup({readDetails:async name=>{const data=details(name);data.arkgrid.cores=[{name:'불명 코어',gems:null}];
    data.bracelet={name:'장착 팔찌'};data.efficiency={braceletExpectation:{targetKey:hash}};return data;},
    braceletValue:{get:async()=>({characterName:'테스트바드',targetKey:'b'.repeat(64),costExpectedGold:999999,price:{checkedAt:timestamp}})}});t.after(()=>service.close());
  const value=(await service.get('테스트바드','character')).characters[0].value;
  assert.equal(value.components.arkgridGems.complete,false);assert.equal(value.components.arkgridGems.counts.unknown,1);
  assert.equal(value.components.bracelet.complete,false);assert.equal(value.totalGold,null);assert.equal(value.knownGold,0);
  assert.equal(value.braceletDetails,null);
});

test('cores carrying no gem are a known empty set worth zero, not an unknown source',async t=>{
  const service=setup({readDetails:async name=>{const data=details(name);
    data.arkgrid.cores=[{name:'해의 코어',gems:[]},{name:'달의 코어',gems:[]}];return data;}});t.after(()=>service.close());
  const value=(await service.get('테스트바드','character')).characters[0].value;
  assert.equal(value.components.arkgridGems.status,'empty');assert.equal(value.components.arkgridGems.complete,true);
  assert.equal(value.components.arkgridGems.totalGold,0);assert.equal(value.components.arkgridGems.counts.unknown,0);
  assert.equal(value.gemValuation.scenarios.general.complete,true);assert.equal(value.gemValuation.scenarios.general.totalGold,0);
  assert.equal(value.status,'ok');assert.equal(value.totalGold,0);
});

test('a bracelet the model cannot price is completed from a replacement listing and counted as estimated',async t=>{
  let asked=null;
  const service=setup({readDetails:async name=>{const data=details(name);
    data.bracelet={name:'찬란한 구원자의 팔찌',tier:4,grade:'고대',stats:[{name:'치명',value:70,text:'치명 +70'},
      {name:'무기 공격력',value:7200,text:'무기 공격력 +7200'}],effects:[{text:'특화 +100'}]};return data;},
    braceletValue:{get:async()=>{throw Object.assign(Error('unavailable'),{status:502});},
      replacement:async input=>{asked=input;return {status:'ok',basis:'bracelet_market_average',meanGold:5000,
        targetKey:'b'.repeat(64),modelVersion:'bracelet-replacement-2026-09-19.1',checkedAt:timestamp};}}});
  t.after(()=>service.close());
  const answer=await service.get('테스트바드','character'),value=answer.characters[0].value;
  // Only the stat lines the search understands are sent, wherever the tooltip listed them.
  assert.deepEqual(asked,{tier:4,grade:'고대',stats:[{name:'치명',value:70},{name:'특화',value:100}]});
  const item=value.components.bracelet.items[0];
  assert.equal(value.components.bracelet.status,'ok');assert.equal(item.status,'ok');
  assert.equal(item.estimated,true);assert.equal(item.basis,'bracelet_market_average');
  assert.equal(value.components.bracelet.counts.estimated,1);assert.equal(value.estimatedItems,1);
  assert.equal(value.status,'ok');assert.equal(value.totalGold,5000);
  assert.equal(value.braceletDetails.replacement.meanGold,5000);
  assert.equal(answer.aggregate.estimatedItems,1);assert.equal(answer.aggregate.counts.estimatedCharacters,1);
  // The bot's 뽑기 기댓값 row means a conversion expectation, so a market replacement never stands in for it.
  const expectation=(await service.expectations('테스트바드')).characters[0].value;
  assert.equal(expectation.components.bracelet.status,'unavailable');
  assert.equal(expectation.components.bracelet.complete,false);assert.deepEqual(expectation.components.bracelet.items,[]);
});
test('a bracelet without a usable replacement stays unknown instead of becoming zero',async t=>{
  const service=setup({readDetails:async name=>{const data=details(name);data.bracelet={name:'장착 팔찌',tier:4,grade:'고대',stats:[]};return data;},
    braceletValue:{get:async()=>{throw Object.assign(Error('unavailable'),{status:502});},
      replacement:async()=>({status:'no_listings',basis:'bracelet_market_average',meanGold:null})}});
  t.after(()=>service.close());
  const value=(await service.get('테스트바드','character')).characters[0].value;
  assert.equal(value.components.bracelet.status,'unavailable');assert.equal(value.estimatedItems,0);
  assert.equal(value.totalGold,null);
});

test('gem prices compare both grades, retain core identities and sum four cost scenarios',async t=>{
  const calls=[];
  const alternative=(grade,count,price,processing)=>({status:'ok',modelVersion:'test',startingGrade:grade,comparison:'at-least',
    expectedStartingGems:count,successProbability:1/count,purchaseGold:price,purchaseExpectedGold:count*price,
    processingExpectedGold:processing,totalExpectedGold:count*price+processing});
  const service=setup({readDetails:async name=>{const data=details(name);data.arkgrid.cores=[{slot:2,name:'질서의 별 코어',gems:[
    {slot:0,name:'질서의 젬 : 안정',icon:'https://cdn-lostark.game.onstove.com/a.png',points:18,target:{status:'ok',subtype:'안정',targetKey:hash}}]}];return data;},
    prices:{gemCatalogue:async()=>({prices:{'안정:영웅':{status:'ok',unitGold:100,checkedAt:timestamp},'안정:희귀':{status:'ok',unitGold:10,checkedAt:timestamp}}})},
    currency:{get:async()=>({status:'ok',price95:9500,pheonUnitGold:850,observedAt:timestamp,checkedAt:timestamp})},
    gemSolver:{getBest:async(_target,options)=>{calls.push(options.purchaseGoldByGrade);return {status:'ok',modelVersion:'test',alternatives:[alternative('희귀',2,10,200),alternative('영웅',1,100,1000)]};},close(){}}});
  t.after(()=>service.close());const data=await service.get('테스트바드','character'),value=data.characters[0].value;
  assert.deepEqual(calls,[{희귀:10,영웅:100}]);
  assert.equal(value.gemDetails[0].coreSlot,2);assert.equal(value.gemDetails[0].slot,0);assert.equal(value.gemDetails[0].points,18);
  assert.equal(value.gemDetails[0].scenarios.boundBoth.totalExpectedGold,20);
  assert.equal(data.gemValuation.scenarios.boundBoth.totalGold,20);
  assert.equal(value.components.arkgridGems.totalGold,data.gemValuation.scenarios.general.totalGold);
});

test('roster engraving books are summed once per server at the top and each character value carries excludingSharedBooks',async t=>{
  const book=level=>({id:'engraving:0',status:'ok',kind:'engraving',name:'원한',targetKey:hash,accountKey:'engraving:루페온:원한',grade:'유물',level,
    recipeVersion:'official-engraving-2026-09-16',bookQuotes:[{grade:'유물',quoteKey:'relic',quantity:level*5}]});
  const service=setup({readDetails:async name=>{const data=details(name);data.valuationTargets.quotes=[{quoteKey:'relic'}];
      data.valuationTargets.components.engravings={status:'ok',items:[book(name==='테스트바드'?2:4)]};return data;},
    prices:{get:async()=>({status:'ok',unitGold:100,checkedAt:timestamp})}});t.after(()=>service.close());
  const running=await service.get('테스트바드');assert.equal(running.status,'running');
  assert.equal(running.aggregate.engravingBooksComplete,false);assert.equal(running.aggregate.components.engravings.complete,false);
  const data=await service.get('테스트바드');assert.equal(data.status,'done');
  assert.equal(data.aggregate.engravingBooksGold,2000);assert.equal(data.aggregate.engravingBooksComplete,true);
  assert.equal(data.aggregate.components.engravings.totalGold,2000);assert.deepEqual(data.aggregate.components.engravings.counts,{items:1,known:1,unknown:0,estimated:0});
  assert.equal('sharedDeductionGold' in data.aggregate,false);assert.equal('sharedItems' in data.aggregate,false);
  assert.deepEqual(data.aggregate.engravingBooks.map(row=>[row.name,row.level,row.characters]),[['원한',4,['다른캐릭터','테스트바드']]]);
  assert.equal(data.aggregate.totalGold,2000);assert.equal(data.aggregate.knownMarketReplacementGold,2000);
  for(const row of data.characters){assert.equal(row.value.excludingSharedBooks.totalGold,0);assert.equal(row.value.excludingSharedBooks.complete,true);}
  assert.equal(data.characters[0].value.totalGold,1000);assert.equal(data.characters[0].value.components.engravings.items[0].name,'원한 · 유물 Lv.2');
});

test('a roster keeps completed rows when rate-limited work resumes within its idle lifetime',async t=>{
  let time=timestamp;const calls=[];
  const service=setup({now:()=>time,cacheMs:100,readRoster:async()=>({roster:{characters:['테스트바드','다른캐릭터','마지막캐릭터'].map(characterName=>({characterName}))}}),
    readDetails:async name=>{calls.push(name);const data=details(name);data.valuationTargets.observedAt=time;data.updatedAt=time;return data;}});t.after(()=>service.close());
  assert.equal((await service.get('테스트바드')).progress.done,1);time+=80;
  assert.equal((await service.get('테스트바드')).progress.done,2);time+=80;
  assert.equal((await service.get('테스트바드')).progress.done,3);
  assert.deepEqual(calls,['테스트바드','다른캐릭터','마지막캐릭터']);
});

test('bracelet totals use the saved maximum for the same target and policy, including an older record',async t=>{
  const record={characterName:'테스트바드',targetKey:hash,policyVersion:'bracelet-three-reconversion-v2:bounded-combat-v1:log2sd-v1',
    costExpectedGold:8000,recordedAt:timestamp-86400000,basePriceGold:2000,expectedStartingBracelets:4,successProbability:.25,expectedReconversionTicketsUntilSuccess:5};
  for(const mode of ['lower','no_listings','wrong_target','old_policy','old_ticket_policy','tier_three']) {
    const saved={...record};if(mode==='wrong_target')saved.targetKey='b'.repeat(64);if(mode==='old_policy')saved.policyVersion='old';
    if(mode==='tier_three'){saved.policyVersion='bracelet-t3-no-reconversion-v1:bounded-combat-v1:log2sd-v1';saved.expectedReconversionTicketsUntilSuccess=0;}
    const result={status:mode==='no_listings'?'no_listings':'ok',characterName:'테스트바드',targetKey:hash,reconversionTickets:mode==='old_ticket_policy'?0:3,totalRolls:mode==='old_ticket_policy'?4:7,
      costExpectedGold:mode==='no_listings'?null:4000,price:{checkedAt:timestamp},record:saved,recordStatus:'saved'};
    if(mode==='tier_three')Object.assign(result,{tier:3,reconversionTickets:0,totalRolls:4});
    const service=setup({readDetails:async name=>{const data=details(name);data.bracelet={name:'장착 팔찌'};data.efficiency={braceletExpectation:{targetKey:hash}};return data;},braceletValue:{get:async()=>result}});t.after(()=>service.close());
    const value=(await service.get('테스트바드','character')).characters[0].value;
    assert.equal(value.components.bracelet.totalGold,mode==='old_ticket_policy'?null:['lower','no_listings','tier_three'].includes(mode)?8000:4000,mode);
  }
});

test('bot expectations compute the bracelet and gem rows together without market quotes, cache them, and never cache a throttled answer',async t=>{
  let quotes=0,bracelets=0,catalogues=0,throttle=false;
  const braceletResult={status:'ok',characterName:'테스트바드',targetKey:hash,reconversionTickets:3,totalRolls:7,costExpectedGold:4000,price:{checkedAt:timestamp},record:null};
  const service=setup({readDetails:async name=>{const data=details(name);data.bracelet={name:'장착 팔찌'};data.efficiency={braceletExpectation:{targetKey:hash}};
      data.valuationTargets.quotes=[{quoteKey:'q1'}];data.valuationTargets.components.accessories={status:'ok',items:[{id:'acc',quoteKey:'q1'}]};
      data.arkgrid.cores=[{name:'해의코어',gems:[{name:'질서의 젬 : 안정',target:{status:'ok',subtype:'안정',targetKey:hash}}]}];return data;},
    prices:{get:async()=>{quotes++;return {status:'ok'};},gemCatalogue:async()=>{catalogues++;return {prices:{'안정:영웅':{status:'ok',unitGold:100,checkedAt:timestamp}}};}},
    currency:{get:async()=>({status:'ok',pheonUnitGold:100})},
    gemSolver:{getBest:async()=>({status:'ok',modelVersion:'test',alternatives:[{status:'ok',startingGrade:'영웅',expectedStartingGems:1,successProbability:1,purchaseGold:100,purchaseExpectedGold:100,processingExpectedGold:3700,totalExpectedGold:3800}]}),close(){}},
    braceletValue:{get:async()=>{bracelets++;if(throttle)throw new GuildError(429,'bracelet_value_rate_limited');return braceletResult;}}});
  t.after(()=>service.close());
  const first=await service.expectations('테스트바드');
  assert.equal(first.status,'done');assert.equal(first.characters[0].state,'done');
  const value=first.characters[0].value;
  assert.equal(value.scope,'expectations');assert.equal(quotes,0,'no market quote is requested for the bot rows');
  assert.equal(value.components.bracelet.items[0].expectedAcquisitionGold,4000);assert.equal(value.components.bracelet.items[0].name,'장착 팔찌');
  assert.equal(value.components.arkgridGems.complete,true);assert.ok(value.components.arkgridGems.totalGold>0);assert.equal(value.components.arkgridGems.items[0].name,'질서의 젬 : 안정');
  assert.equal(value.gemValuation.scenarios.general.totalGold,value.components.arkgridGems.totalGold);assert.equal(value.components.accessories.items.length,0);
  await service.expectations('테스트바드');assert.equal(bracelets,1);assert.equal(catalogues,1);
  await assert.rejects(service.expectations('x'),{status:400});
  throttle=true;
  const throttledService=setup({readDetails:async name=>{const data=details(name);data.bracelet={name:'장착 팔찌'};data.efficiency={braceletExpectation:{targetKey:hash}};return data;},
    braceletValue:{get:async()=>{bracelets++;if(throttle)throw new GuildError(429,'bracelet_value_rate_limited');return braceletResult;}}});
  t.after(()=>throttledService.close());
  const limited=(await throttledService.expectations('테스트바드')).characters[0].value;
  assert.equal(limited.components.bracelet.items[0].status,'unavailable');assert.equal(limited.components.bracelet.items[0].reason,'rate_limited');assert.equal(limited.components.bracelet.items[0].name,'장착 팔찌');
  throttle=false;const recovered=(await throttledService.expectations('테스트바드')).characters[0].value;
  assert.equal(recovered.components.bracelet.items[0].expectedAcquisitionGold,4000,'the throttled answer was not cached');
  assert.equal(bracelets,3);
});

// 원정대 최고 기록은 기록 시점의 장비를 사본으로 들고 있다가 매일 오늘 시세로 다시 값을 매긴다
// (README.md). 사본이 평가가 읽는 필드를 하나라도 빠뜨리면 값이 달라지므로,
// 여기서 「사본으로 매긴 값 = 원본으로 매긴 값」을 고정한다.
function recordDetails(name) {
  const data=details(name);
  data.equipment=[{Type:'무기'}];
  data.bracelet={name:'찬란한 구원자의 팔찌',tier:4,grade:'고대',icon:'https://example.invalid/bracelet.png',
    stats:[{name:'치명',value:70,text:'치명 +70'}],effects:[{text:'특화 +100'}]};
  data.arkgrid={cores:[{name:'해의 코어',slot:'sun',icon:'https://example.invalid/core.png',
    gems:[{name:'질서의 젬',slot:1,icon:'https://example.invalid/gem.png',points:5,
      target:{status:'ok',targetKey:'c'.repeat(64),subtype:'order',points:5,name:'질서의 젬'}}]},
    {name:'달의 코어',slot:'moon'}]};
  data.efficiency={braceletExpectation:{targetKey:hash,status:'ok',rows:[{label:'무시'}]},score:{role:'support',total:812}};
  data.crit={value:70};
  data.combatStats={치명:1800};
  return data;
}
// The auction answers with today's observation time, whatever day the recorded equipment came from.
function recordSetup(overrides={},clock=()=>timestamp) {
  return setup({readDetails:async name=>recordDetails(name),
    braceletValue:{get:async()=>{throw Object.assign(Error('unavailable'),{status:502});},
      replacement:async input=>({status:'ok',basis:'bracelet_market_average',meanGold:1000*input.stats.length,
        targetKey:'b'.repeat(64),modelVersion:'bracelet-replacement-2026-09-19.1',checkedAt:clock()})},
    prices:{get:async()=>({status:'unavailable'}),gemCatalogue:async()=>({prices:{}})},...overrides});
}

test('a saved snapshot keeps only what the valuation reads and prices to the same value',async t=>{
  const inputs=snapshotValuationInputs(recordDetails('테스트바드'));
  assert.equal(inputs.version,VALUATION_INPUTS_VERSION);
  assert.deepEqual(Object.keys(inputs).sort(),['arkgrid','bracelet','efficiency','equipment','updatedAt','valuationTargets','version']);
  // Display-only detail is dropped, and the equipment list is kept only as "there was one".
  assert.equal(inputs.crit,undefined);assert.equal(inputs.combatStats,undefined);
  assert.deepEqual(inputs.equipment,[]);
  assert.deepEqual(inputs.bracelet.stats,[{text:'치명 +70'}]);
  assert.deepEqual(inputs.bracelet.effects,[{text:'특화 +100'}]);
  assert.equal(inputs.bracelet.icon,undefined);
  assert.deepEqual(inputs.efficiency,{braceletExpectation:{targetKey:hash,status:'ok'},score:{role:'support'}});
  assert.equal(inputs.arkgrid.cores[1].gems,null,'a core whose gems are unknown stays unknown');
  assert.ok(Buffer.byteLength(JSON.stringify(inputs))<256*1024);

  // Two services, because one would answer the second request from its own five minute cache.
  const live=recordSetup(),replay=recordSetup();
  t.after(()=>{live.close();replay.close();});
  const direct=await live.value('테스트바드');
  const replayed=await replay.valueFrom('테스트바드',inputs);
  assert.equal(direct.components.bracelet.items[0].expectedAcquisitionGold,2000,'both bracelet option lines reached the search');
  assert.deepEqual(replayed,direct);
  await assert.rejects(replay.valueFrom('x',inputs),{status:400});
  await assert.rejects(replay.valueFrom('테스트바드',null),{status:502});
});

test('a snapshot older than the quote window is priced at today\u2019s date, not refused as stale',async t=>{
  let clock=timestamp;
  const inputs=snapshotValuationInputs(recordDetails('테스트바드'));
  const service=recordSetup({now:()=>clock},()=>clock);
  t.after(()=>service.close());
  clock=timestamp+86400000;
  const replayed=await service.valueFrom('테스트바드',inputs);
  assert.equal(replayed.observedAt,clock,'the replay is stamped now so the recorded equipment still prices');
  assert.equal(replayed.equipmentUpdatedAt,timestamp,'the equipment is still the one the record froze');
  assert.equal(replayed.components.bracelet.items[0].status,'ok');
  assert.equal(replayed.components.bracelet.items[0].expectedAcquisitionGold,2000);
  // The live path keeps refusing stale targets — only a record replay restamps them.
  const stale=recordSetup({now:()=>clock,readDetails:async name=>{const data=recordDetails(name);
    data.valuationTargets.observedAt=timestamp;return data;}},()=>clock);
  t.after(()=>stale.close());
  assert.equal((await stale.value('테스트바드')).reason,'targets_unavailable_or_stale');
});

test('details a record cannot be taken from produce no snapshot at all',()=>{
  assert.equal(snapshotValuationInputs(null),null);
  assert.equal(snapshotValuationInputs({updatedAt:timestamp}),null);
  assert.equal(snapshotValuationInputs({valuationTargets:{},updatedAt:'어제'}),null);
  assert.equal(snapshotValuationInputs(recordDetails('테스트바드'),{maxBytes:64}),null);
});
