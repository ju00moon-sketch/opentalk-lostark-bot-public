import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildBaseBraceletSearch,normalizeBaseBraceletAuction} from '../src/bracelet-base-price.js';
import {createBraceletValueService} from '../web/src/bracelet-value.js';

const target=()=>({status:'ok',rarity:'ancient',target:[
  {fixed:true,text:'시드 등급 이하 몬스터에게 받는 피해량이 6% 감소한다.',id:'special.seedReduction',tier:1},
  {fixed:true,text:'신속 +86',id:'combat.swiftness',value:86},
  {fixed:false,text:'치명타 적중률이 3.4% 증가한다. 공격이 치명타로 적중 시 적에게 주는 피해가 1.5% 증가한다.',id:'special.critRateDamage',tier:1},
  {fixed:false,text:'특화 +94',id:'combat.specialization',value:94},
  {fixed:false,text:'추가 피해가 3.5% 증가한다. 악마 및 대악마 계열 피해량이 2.5% 증가한다.',id:'special.additionalDemon',tier:3},
]});
const empty={PageNo:1,PageSize:10,TotalCount:0,Items:null};
const listing={Name:'찬란한 구원자의 팔찌',Tier:4,Grade:'고대',AuctionInfo:{BuyPrice:1,TradeAllowCount:0,EndDate:'2026-09-17T12:00:00'},Options:[
  {Type:'BRACELET_SPECIAL_EFFECTS',OptionName:'시드 이하 받는 피해 감소',Value:0,IsValuePercentage:false,IsPenalty:false},
  {Type:'BRACELET_RANDOM_SLOT',OptionName:'부여 효과 수량',Value:3,IsValuePercentage:false,IsPenalty:false},
  {Type:'STAT',OptionName:'신속',Value:86,IsValuePercentage:false,IsPenalty:false},
]};
test('unknown special units permit only an explicit availability query with exact remaining conditions',()=>{
  const e=target(),before=JSON.stringify(e);
  assert.equal(buildBaseBraceletSearch(e).reason,'fixed_special_value_unverified');
  const s=buildBaseBraceletSearch(e,{checkAvailability:true});
  assert.equal(s.status,'ok');assert.equal(s.availabilityOnly,true);
  assert.deepEqual(s.body.EtcOptions,[
    {FirstOption:2,SecondOption:18,MinValue:81,MaxValue:91},
    {FirstOption:5,SecondOption:62,MinValue:0,MaxValue:999999},
    {FirstOption:4,SecondOption:1,MinValue:2,MaxValue:2},
    {FirstOption:4,SecondOption:2,MinValue:3,MaxValue:3},
  ]);
  assert.equal(normalizeBaseBraceletAuction(empty,s).status,'no_listings');
  const r=normalizeBaseBraceletAuction({...empty,TotalCount:1,Items:[listing]},s);
  assert.equal(r.status,'unavailable');assert.equal(r.reason,'fixed_special_value_unverified');assert.deepEqual(r.samples,[]);
  assert.equal(JSON.stringify(e),before);
  e.target[0].text+=' 다른 효과';assert.equal(buildBaseBraceletSearch(e,{checkAvailability:true}).status,'unavailable');
});
test('availability query never accepts contradictory or malformed empty pages',()=>{
  const s=buildBaseBraceletSearch(target(),{checkAvailability:true});
  for(const page of [{...empty,Items:undefined},{...empty,TotalCount:1},{...empty,PageNo:2},{...empty,PageSize:11}])
    assert.equal(normalizeBaseBraceletAuction(page,s).status,'unavailable');
});
test('service drops the unverifiable special effect and prices the fixed combat stat instead of checking availability',async t=>{
  for(const present of [false,true]){
    const e=target();e.targetKey=createHash('sha256').update(JSON.stringify({rarity:e.rarity,target:e.target})).digest('hex');
    e.scenarios=[{reconversionTickets:3,totalRolls:7,expectedStartingBracelets:4,successProbability:.25,expectedReconversionTicketsPerBracelet:2,expectedReconversionTicketsUntilSuccess:8}];
    let calls=0;
    const app=createBraceletValueService({config:{automaticApproval:{lostArkApiKey:'synthetic-special'}},now:()=>Date.parse('2026-09-16T12:00:00+09:00'),
      readDetails:async()=>({efficiency:{source:'official-api',characterName:'시험캐릭터',braceletExpectation:e}}),
      fetchImpl:async(_url,init)=>{calls++;assert.deepEqual(JSON.parse(init.body).EtcOptions,[{FirstOption:2,SecondOption:18,MinValue:81,MaxValue:91},{FirstOption:4,SecondOption:1,MinValue:2,MaxValue:2},{FirstOption:4,SecondOption:2,MinValue:3,MaxValue:3}]);return new Response(JSON.stringify(present?{...empty,TotalCount:1,Items:[listing]}:empty),{headers:{'Content-Type':'application/json'}});}});
    t.after(()=>app.close());
    const r=await app.get('시험캐릭터');assert.equal(calls,1);assert.equal(r.status,present?'ok':'no_listings');
    assert.equal(r.costExpectedGold,present?4:null);assert.equal(r.price.meanGold,present?1:null);assert.equal(r.price.availabilityOnly,undefined);
    assert.equal(r.price.relaxation,'stats-only');assert.equal(r.price.basisVersion,'bounded-combat-v2');
    assert.deepEqual(r.price.conditions.fixed,[{name:'신속',operator:'range',value:86,min:81,max:91,tolerance:5,used:true},{name:'시드 이하 받는 피해 감소',operator:'any',value:6,min:null,max:null,tolerance:0,used:false}]);
    assert.equal(r.expectedStartingBracelets,4);if(!present)assert.match(r.reason,/매물/);
    assert.equal((await app.get('시험캐릭터')).status,r.status);assert.equal(calls,1);
  }
});
