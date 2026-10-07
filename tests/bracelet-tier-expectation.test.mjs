import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateBraceletExpectation} from '../src/bracelet-expectation.js';
import {readBraceletExpectationInput} from '../src/bracelet-expectation-input.js';
import {analyzeBraceletExpectation} from '../src/character-bracelet-expectation.js';
import {buildBaseBraceletSearch,normalizeBaseBraceletAuction} from '../src/bracelet-base-price.js';
import {createBraceletValueService} from '../web/src/bracelet-value.js';
import {BRACELET_T3_VALUE_RECORD_POLICY as POLICY,BRACELET_VALUE_RECORD_POLICY as T4_POLICY} from '../web/src/bracelet-value-record-store.js';

function item(fixed,granted,grade='유물',tier=3){return {Type:'팔찌',Grade:grade,Tooltip:JSON.stringify({
 title:{type:'ItemTitle',value:{leftStr2:`아이템 티어 ${tier}`}},effects:{type:'ItemPartBox',value:{Element_000:'팔찌 효과',Element_001:[
 ...fixed.map(text=>`<img src='emoticon_tooltip_bracelet_locked'></img>${text}`),...granted.map(text=>`<img src='emoticon_tooltip_bracelet_changeable'></img>${text}`)].join('<BR>')}}})};}
const t3=()=>item(['체력 +2075','특화 +77'],['신속 +54']);
test('T3 one-slot full-range target matches an independent Bernoulli oracle and refuses tickets',()=>{
 const input={itemTier:3,rarity:'relic',fixed:[{id:'combat.crit',value:41}],granted:[{id:'base.mainStat',value:1500}],reconversionTickets:0};
 const before=JSON.stringify(input),r=calculateBraceletExpectation(input),first=(.35*.5)/(1-.35/6),success=1-(1-first)**4;
 assert.equal(r.tier,3);assert.equal(r.reconversionTickets,0);assert.equal(r.totalRolls,4);assert.equal(r.scenarios.length,1);assert.equal(r.probabilityByRoll.length,4);
 assert(Math.abs(r.initialGrantProbability-first)<1e-12);assert(Math.abs(r.successProbability-success)<1e-12);
 assert.equal(r.expectedReconversionTicketsUntilSuccess,0);assert.equal(JSON.stringify(input),before);
 assert.throws(()=>calculateBraceletExpectation({...input,reconversionTickets:3}));
 assert.throws(()=>calculateBraceletExpectation({...input,itemTier:4}));
 for(const itemTier of [2,5,'3',[3]])assert.throws(()=>calculateBraceletExpectation({...input,itemTier}));
});
test('T4 pre-generalization probabilities and expected ticket quantities remain numerically identical',()=>{
 const r=calculateBraceletExpectation({rarity:'ancient',fixed:[{id:'combat.crit',value:83},{id:'combat.specialization',value:90}],
 granted:[{id:'base.mainStat',value:14912},{id:'special.critDamageDamage',tier:2},{id:'special.critRateDamage',tier:3}],reconversionTickets:3});
 assert.equal(r.tier,4);assert.equal(r.successProbability,.000030435730653976903);assert.equal(r.expectedStartingBracelets,32856.11938707752);
 assert.equal(r.expectedReconversionTicketsUntilSuccess,98567.14182722334);assert.equal(r.probabilityByRoll.length,7);
});
test('the official tier selects its parser probability model and grade-specific base ranges',()=>{
 const gear=t3(),before=JSON.stringify(gear),input=readBraceletExpectationInput(gear),r=analyzeBraceletExpectation({ArmoryEquipment:[gear]});
 assert.equal(input.status,'ok');assert.equal(input.input.itemTier,3);assert.equal(r.status,'ok');assert.equal(r.tier,3);assert.equal(r.totalRolls,4);assert.equal(r.reconversionTickets,0);
 assert.equal(r.expectedReconversionTicketsPerBracelet,0);assert.equal(r.reconversionTicketUnitGold,null);assert.match(r.sources.probability,/T3/);
 const s=buildBaseBraceletSearch(r);assert.equal(s.status,'ok');assert.equal(s.body.ItemTier,3);assert.equal(s.tier,3);
 assert.deepEqual(s.body.EtcOptions,[{FirstOption:1,SecondOption:6,MinValue:2075,MaxValue:2075},{FirstOption:2,SecondOption:16,MinValue:72,MaxValue:82},{FirstOption:4,SecondOption:1,MinValue:2,MaxValue:2},{FirstOption:4,SecondOption:2,MinValue:1,MaxValue:1}]);
 const listing={Name:'빛나는 구원자의 팔찌',Tier:3,Grade:'유물',AuctionInfo:{BuyPrice:10,TradeAllowCount:0,EndDate:'2099-01-01T00:00:00Z'},Options:[
 {Type:'STAT',OptionName:'체력',Value:2075,IsValuePercentage:false},{Type:'STAT',OptionName:'특화',Value:77,IsValuePercentage:false},{Type:'BRACELET_RANDOM_SLOT',OptionName:'부여 효과 수량',Value:1,IsValuePercentage:false}]};
 const page={PageNo:1,PageSize:10,TotalCount:1,Items:[listing]};
 assert.equal(normalizeBaseBraceletAuction(page,s).status,'ok');listing.Tier=4;assert.equal(normalizeBaseBraceletAuction(page,s).status,'unavailable');
 assert.equal(JSON.stringify(gear),before);
 for(const tier of [2,30,40])assert.equal(readBraceletExpectationInput(item(['체력 +2075','특화 +77'],['신속 +54'],'유물',tier)).status,'unavailable');
});
test('T3 service uses its own durable policy and no tickets when listings are absent',async t=>{
 const expectation=analyzeBraceletExpectation({ArmoryEquipment:[t3()]});let readPolicy,writePolicy,saved;
 const app=createBraceletValueService({config:{automaticApproval:{lostArkApiKey:'tier-test'}},recordStore:{get:(_n,_k,p)=>{readPolicy=p;return null;},record:(n,k,p,v)=>{writePolicy=p;return saved={characterName:n,targetKey:k,policyVersion:p,...v};}},
 readDetails:async()=>({efficiency:{source:'official-api',characterName:'시험캐릭터',braceletExpectation:expectation}}),
 fetchImpl:async(_url,init)=>{assert.equal(JSON.parse(init.body).ItemTier,3);return Response.json({PageNo:1,PageSize:10,TotalCount:0,Items:[]});}});t.after(()=>app.close());
 const r=await app.get('시험캐릭터');assert.equal(r.status,'no_listings');assert.equal(r.tier,3);assert.equal(r.reconversionTickets,0);assert.equal(r.totalRolls,4);assert.equal(r.expectedReconversionTicketsUntilSuccess,0);assert.equal(readPolicy,POLICY);assert.equal(writePolicy,undefined);assert.equal(saved,undefined);
});
test('T3 current quotes record zero ticket use and reject a different tier policy on later empty quotes',async t=>{
 const expectation=analyzeBraceletExpectation({ArmoryEquipment:[t3()]});let record=null,empty=false;
 const app=createBraceletValueService({config:{automaticApproval:{lostArkApiKey:'tier-test'}},cacheMs:0,
 recordStore:{get:()=>record,record:(characterName,targetKey,policyVersion,row)=>record={characterName,targetKey,policyVersion,...row}},
 readDetails:async()=>({efficiency:{source:'official-api',characterName:'시험캐릭터',braceletExpectation:expectation}}),
 fetchImpl:async()=>Response.json({PageNo:1,PageSize:10,TotalCount:empty?0:1,Items:empty?[]:[{
 Name:'빛나는 구원자의 팔찌',Tier:3,Grade:'유물',AuctionInfo:{BuyPrice:10,TradeAllowCount:0,EndDate:'2099-01-01T00:00:00Z'},Options:[
 {Type:'STAT',OptionName:'체력',Value:2075,IsValuePercentage:false},{Type:'STAT',OptionName:'특화',Value:77,IsValuePercentage:false},{Type:'BRACELET_RANDOM_SLOT',OptionName:'부여 효과 수량',Value:1,IsValuePercentage:false}]}]})});t.after(()=>app.close());
 const r=await app.get('시험캐릭터');assert.equal(r.status,'ok');assert.equal(r.recordStatus,'saved');assert.equal(r.record.policyVersion,POLICY);assert.equal(r.record.expectedReconversionTicketsUntilSuccess,0);
 assert.equal(r.costExpectedGold,10*expectation.expectedStartingBracelets);
 empty=true;record={...record,policyVersion:T4_POLICY};const invalid=await app.get('시험캐릭터');assert.equal(invalid.status,'no_listings');assert.equal(invalid.record,null);assert.equal(invalid.recordStatus,'unavailable');
 expectation.scenarios[0].reconversionTickets=3;await assert.rejects(app.get('시험캐릭터'),{status:502});
});
test('unverified T3 fixed special prices stop with a deliberate reason before reading T4 value tables',()=>{
 const reversal="[<FONT COLOR='#00B5FF'>반전</FONT>] 생명력이 15% 이하일 경우 몬스터에게 피격 시 10초 후 체력 반전이 일어난다. (재사용 대기 시간 900초) (60레벨 초과 몬스터에게는 효과 감소)";
 const r=analyzeBraceletExpectation({ArmoryEquipment:[item([reversal],['힘 +2500','체력 +1500'],'고대')]});
 assert.equal(r.status,'ok');assert.equal(r.tier,3);
 assert.deepEqual(buildBaseBraceletSearch(r,{checkAvailability:true}),{status:'unavailable',reason:'fixed_option_unsupported'});
});
