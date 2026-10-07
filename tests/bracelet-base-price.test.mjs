import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBaseBraceletSearch, buildBaseBraceletSearchPlan, normalizeBaseBraceletAuction, estimateBaseBraceletPrice } from '../src/bracelet-base-price.js';

const target = () => ({status:'ok',rarity:'ancient',fixedCount:2,grantedCount:2,target:[
  {fixed:true,text:'특화 +100',id:'combat.specialization',value:100},
  {fixed:true,text:'치명 +95',id:'combat.crit',value:95},
  {fixed:false,text:'적에게 주는 피해가 2.00% 증가한다.',id:'special.damage',tier:1},
  {fixed:false,text:'추가 피해 +3.00%',id:'special.additionalDamage',tier:1},
]});
const NOW=Date.parse('2026-09-16T12:00:00+09:00');
const item=(price=1000)=>({Name:'고대 팔찌',Tier:4,Grade:'고대',AuctionInfo:{BuyPrice:price,TradeAllowCount:1,EndDate:'2026-09-17T12:00:00.000'},Options:[{Type:'STAT',IsValuePercentage:false,OptionName:'특화',Value:100},{Type:'STAT',IsValuePercentage:false,OptionName:'치명',Value:95},{Type:'BRACELET_RANDOM_SLOT',OptionName:'부여 효과 수량',Value:2},{Type:'ARK_PASSIVE',OptionName:'도약',Value:18}]});
const page=(Items)=>({PageNo:1,PageSize:10,TotalCount:Items.length,Items});

test('builder preserves exact base slots and ignores granted effect content as search filters',()=>{const s=buildBaseBraceletSearch(target());assert.equal(s.status,'ok');assert.equal(s.body.ItemTier,4);assert.equal(s.body.ItemGrade,'고대');assert.equal(s.body.Sort,'BUY_PRICE');assert.equal(s.body.SortCondition,'ASC');assert.deepEqual(s.body.EtcOptions,[{FirstOption:2,SecondOption:15,MinValue:90,MaxValue:100},{FirstOption:2,SecondOption:16,MinValue:95,MaxValue:105},{FirstOption:4,SecondOption:1,MinValue:2,MaxValue:2},{FirstOption:4,SecondOption:2,MinValue:2,MaxValue:2}]);const b=target();b.target.reverse();assert.equal(buildBaseBraceletSearch(b).fingerprint,s.fingerprint)});
test('builder refuses mismatched ids, counts, rarity and unknown fixed text',()=>{for(const mutate of [x=>x.rarity='mythic',x=>x.fixedCount=1,x=>x.target[0].id='combat.crit',x=>x.target[0].text='특화 +100 마법 효과',x=>x.target[0].value=99]){const x=target();mutate(x);assert.equal(buildBaseBraceletSearch(x).status,'unavailable')}});
test('valid auction rows retain repeated genuine prices',()=>{const s=buildBaseBraceletSearch(target()),r=normalizeBaseBraceletAuction(page([item(1000),item(1000)]),s,{now:NOW});assert.equal(r.status,'ok');assert.deepEqual(r.samples.map(x=>x.price),[1000,1000]);assert.equal(r.checkedCount,2);assert.match(r.unprocessedEvidence,/거래/)});
test('mismatched filters, unknown option types, and unknown trade state fail closed',()=>{const s=buildBaseBraceletSearch(target());for(const change of [i=>i.Grade='유물',i=>i.Tier=3,i=>i.Options[0].Value=94,i=>i.Options[2].Value=3,i=>i.Options.push({Type:'NEW_EFFECT',OptionName:'new',Value:1}),i=>delete i.AuctionInfo.TradeAllowCount]){const x=item();change(x);const r=normalizeBaseBraceletAuction(page([x]),s,{now:NOW});assert.equal(r.status,'unavailable');assert.deepEqual(r.samples,[])}});
test('zero or absent buy price and expired offers are excluded rather than zero-valued',()=>{const s=buildBaseBraceletSearch(target()),expired=item(99);expired.AuctionInfo.EndDate='2026-09-15T12:00:00';const r=normalizeBaseBraceletAuction(page([item(0),item(null),expired,item(1000)]),s,{now:NOW});assert.equal(r.status,'ok');assert.deepEqual(r.samples.map(x=>x.price),[1000]);assert.equal(r.excludedCount,3)});
test('malformed envelope, different page, and unsorted positive offers are not accepted',()=>{const s=buildBaseBraceletSearch(target());for(const r of [null,{...page([]),TotalCount:1},{...page([item()]),PageNo:2},page([item(2000),item(1000)])])assert.equal(normalizeBaseBraceletAuction(r,s,{now:NOW}).status,'unavailable')});
test('log-space two sample-SD filter removes extremes then takes arithmetic gold mean',()=>{const samples=[...Array(20).fill(1000),1,1000000].map(price=>({price}));const r=estimateBaseBraceletPrice(samples);assert.equal(r.status,'ok');assert.equal(r.price,1000);assert.equal(r.used,20);assert.equal(r.excluded,2);assert.equal(r.sampleCount,22);assert.equal(r.lowSample,false);assert(r.stddevLog>0);assert.deepEqual(r.spread,{min:1000,max:1000})});
test('small samples, zero variance, non-positive and null remain distinct',()=>{assert.equal(estimateBaseBraceletPrice([]).status,'no_listings');const one=estimateBaseBraceletPrice([{price:1234}]);assert.equal(one.price,1234);assert.equal(one.stddevLog,null);assert.equal(one.lowSample,true);const same=estimateBaseBraceletPrice([{price:10},{price:10}]);assert.equal(same.price,10);assert.equal(same.stddevLog,0);for(const price of [0,null,-1,Infinity,NaN,'1000'])assert.equal(estimateBaseBraceletPrice([{price}]).status,'unavailable')});


test('primary attributes accept only their exact name or the verified official combined label',()=>{const e=target();e.target[0]={fixed:true,text:'힘 +12000',id:'base.mainStat',value:12000};const s=buildBaseBraceletSearch(e);assert.equal(s.status,'ok');assert.deepEqual(s.body.EtcOptions[0],{FirstOption:1,SecondOption:11,MinValue:12000,MaxValue:12000});const x=item();x.Options[0]={Type:'STAT',IsValuePercentage:false,OptionName:'힘',Value:12000};assert.equal(normalizeBaseBraceletAuction(page([x]),s,{now:NOW}).status,'ok');x.Options[0].OptionName='힘 / 민첩 / 지능';assert.equal(normalizeBaseBraceletAuction(page([x]),s,{now:NOW}).status,'ok');for(const name of ['민첩','힘민첩지능']){x.Options[0].OptionName=name;assert.equal(normalizeBaseBraceletAuction(page([x]),s,{now:NOW}).status,'unavailable')}});
test('fixed special exact values are applied while granted effects remain unfiltered',()=>{const e=target();e.target[0]={fixed:true,text:'최대 생명력 +14000',id:'special.maxHp',tier:2};const s=buildBaseBraceletSearch(e);assert.equal(s.status,'ok');assert(s.body.EtcOptions.some(x=>x.FirstOption===5&&x.SecondOption===3&&x.MinValue===14000&&x.MaxValue===14000));const x=item();x.Options[0]={Type:'BRACELET_SPECIAL_EFFECTS',IsValuePercentage:false,OptionName:'최대 생명력',Value:14000};assert.equal(normalizeBaseBraceletAuction(page([x]),s,{now:NOW}).status,'ok');x.Options[0].Value=11200;assert.equal(normalizeBaseBraceletAuction(page([x]),s,{now:NOW}).status,'unavailable')});
test('an explicit empty API list is distinct from an omitted or contradictory list',()=>{const s=buildBaseBraceletSearch(target());assert.equal(normalizeBaseBraceletAuction({...page([]),Items:null},s,{now:NOW}).status,'no_listings');assert.equal(normalizeBaseBraceletAuction({...page([]),Items:undefined},s,{now:NOW}).status,'unavailable')});
test('identical large samples have exactly zero standard deviation',()=>{const r=estimateBaseBraceletPrice(Array.from({length:30},()=>({price:999999})));assert.equal(r.stddevLog,0);assert.equal(r.price,999999);assert.equal(r.excluded,0);assert.equal(r.used,30)});


test('wrong numeric units and incomplete page coverage fail closed',()=>{const s=buildBaseBraceletSearch(target()),x=item();x.Options[0].IsValuePercentage=true;assert.equal(normalizeBaseBraceletAuction(page([x]),s,{now:NOW}).status,'unavailable');assert.equal(normalizeBaseBraceletAuction({...page([item()]),TotalCount:335},s,{now:NOW}).status,'unavailable');assert.equal(normalizeBaseBraceletAuction({PageNo:34,PageSize:10,TotalCount:335,Items:Array.from({length:10},()=>item())},s,{now:NOW,requestedPageNo:34}).status,'unavailable')});

test('the estimator preserves fractional gold means for later expectation multiplication',()=>{const result=estimateBaseBraceletPrice([{price:1000},{price:1001}]);assert.equal(result.price,1000.5)});

test('out-of-table fixed values cannot enter an otherwise qualifying market sample',()=>{const s=buildBaseBraceletSearch(target()),x=item();x.Options[0].Value=999;assert.equal(normalizeBaseBraceletAuction(page([x]),s,{now:NOW}).status,'unavailable');const e=target();e.target[0]={fixed:true,text:'최대 생명력 +14000',id:'special.maxHp',tier:2};const b=buildBaseBraceletSearch(e),y=item();y.Options[0]={Type:'BRACELET_SPECIAL_EFFECTS',IsValuePercentage:false,OptionName:'최대 생명력',Value:15000};assert.equal(normalizeBaseBraceletAuction(page([y]),b,{now:NOW}).status,'unavailable')});

test('special engraving values with unverified API units are rejected before a request',()=>{const e=target();e.target[0]={fixed:true,text:'공격 및 이동 속도가 6% 증가한다.',id:'special.attackMoveSpeed',tier:3};const result=buildBaseBraceletSearch(e);assert.equal(result.status,'unavailable');assert.equal(result.reason,'fixed_special_value_unverified')});

test('out-of-window fixed stats and higher special tiers cannot inflate the starting bracelet price',()=>{
  const e=target(), s=buildBaseBraceletSearch(e);
  assert.deepEqual(s.conditions,[{name:'치명',operator:'range',value:95,min:90,max:100,tolerance:5,used:true},{name:'특화',operator:'range',value:100,min:95,max:105,tolerance:5,used:true}]);
  for(const [index,value] of [[0,106],[0,120],[1,101],[1,120]]){
    const x=item();x.Options[index].Value=value;
    const r=normalizeBaseBraceletAuction(page([item(),x]),s,{now:NOW});
    assert.equal(r.status,'unavailable');assert.deepEqual(r.samples,[]);
  }
  e.target[0]={fixed:true,text:'최대 생명력 +14000',id:'special.maxHp',tier:2};
  const special=buildBaseBraceletSearch(e),x=item();
  x.Options[0]={Type:'BRACELET_SPECIAL_EFFECTS',IsValuePercentage:false,OptionName:'최대 생명력',Value:16800};
  assert.equal(normalizeBaseBraceletAuction(page([x]),special,{now:NOW}).status,'unavailable');
});

test('official same-value listing qualifies in the bounded comparison without accepting 120 stats',()=>{
  const e={status:'ok',rarity:'ancient',fixedCount:2,grantedCount:3,target:[
    {fixed:true,text:'특화 +90',id:'combat.specialization',value:90},
    {fixed:true,text:'치명 +83',id:'combat.crit',value:83},
    {fixed:false,text:'민첩 +14912',id:'base.mainStat',value:14912},
    {fixed:false,text:'치명타 피해가 8.4% 증가한다. 공격이 치명타로 적중 시 적에게 주는 피해가 1.5% 증가한다.',id:'special.critDamageDamage',tier:2},
    {fixed:false,text:'치명타 적중률이 5% 증가한다. 공격이 치명타로 적중 시 적에게 주는 피해가 1.5% 증가한다.',id:'special.critRateDamage',tier:3},
  ]};
  const before=structuredClone(e),search=buildBaseBraceletSearch(e);
  assert.deepEqual(e,before);
  assert.deepEqual(search.body.EtcOptions,[
    {FirstOption:2,SecondOption:15,MinValue:78,MaxValue:88},
    {FirstOption:2,SecondOption:16,MinValue:85,MaxValue:95},
    {FirstOption:4,SecondOption:1,MinValue:2,MaxValue:2},
    {FirstOption:4,SecondOption:2,MinValue:3,MaxValue:3},
  ]);
  // Relevant fields copied from the official 2026-09-16 exact-filter response.
  const response={PageNo:1,PageSize:10,TotalCount:1,Items:[{
    Name:'찬란한 구원자의 팔찌',Grade:'고대',Tier:4,
    AuctionInfo:{BuyPrice:19800,EndDate:'2026-09-17T04:16:41.797',IsCompetitive:false,TradeAllowCount:0},
    Options:[
      {Type:'BRACELET_RANDOM_SLOT',OptionName:'부여 효과 수량',Value:3,IsPenalty:false,IsValuePercentage:false},
      {Type:'ARK_PASSIVE',OptionName:'도약',Value:18,IsPenalty:false,IsValuePercentage:false},
      {Type:'STAT',OptionName:'치명',Value:83,IsPenalty:false,IsValuePercentage:false},
      {Type:'STAT',OptionName:'특화',Value:90,IsPenalty:false,IsValuePercentage:false},
    ],
  }]};
  const normalized=normalizeBaseBraceletAuction(response,search,{now:NOW});
  assert.equal(normalized.status,'ok');assert.equal(normalized.totalCount,1);
  const price=estimateBaseBraceletPrice(normalized.samples);
  assert.equal(price.price,19800);assert.equal(price.lowSample,true);
  response.Items[0].Options[2].Value=120;
  response.Items[0].Options[3].Value=120;
  assert.equal(normalizeBaseBraceletAuction(response,search,{now:NOW}).status,'unavailable');
});

function combatTarget(specialization,crit=95,rarity='ancient') {
  const e=target();e.rarity=rarity;
  e.target[0]={fixed:true,text:`특화 +${specialization}`,id:'combat.specialization',value:specialization};
  e.target[1]={fixed:true,text:`치명 +${crit}`,id:'combat.crit',value:crit};
  if(rarity==='relic'){
    e.target[2].text='적에게 주는 피해가 1.50% 증가한다.';
    e.target[3].text='추가 피해 +2.50%';
  }
  return e;
}

test('combat comparison narrows symmetrically near each grade ceiling and clamps its floor',()=>{
  for(const [rarity,value,min,max,tolerance] of [
    ['ancient',90,85,95,5],['ancient',118,116,120,2],
    ['ancient',119,118,120,1],['ancient',120,120,120,0],
    ['ancient',61,61,66,5],['ancient',62,61,67,5],
    ['relic',90,85,95,5],['relic',98,96,100,2],
    ['relic',99,98,100,1],['relic',100,100,100,0],['relic',41,41,46,5],
  ]){
    const e=combatTarget(value,95,rarity),before=structuredClone(e),s=buildBaseBraceletSearch(e);
    assert.equal(s.status,'ok');assert.deepEqual(e,before);
    const r=s.rules.find(rule=>rule.id==='combat.specialization');
    assert.deepEqual({value:r.value,min:r.min,max:r.max,tolerance:r.tolerance,operator:r.operator},
      {value,min,max,tolerance,operator:tolerance===0?'=':'range'});
    assert(s.body.EtcOptions.some(o=>o.FirstOption===2&&o.SecondOption===16&&o.MinValue===min&&o.MaxValue===max));
    for(const offered of [min,max]){
      const x=item();x.Grade=s.grade;x.Options[0].Value=offered;
      assert.equal(normalizeBaseBraceletAuction(page([x]),s,{now:NOW}).status,'ok');
    }
    for(const offered of [min-1,max+1]){
      const x=item(999999999);x.Grade=s.grade;x.Options[0].Value=offered;
      const r=normalizeBaseBraceletAuction(page([x]),s,{now:NOW});
      assert.equal(r.status,'unavailable');assert.deepEqual(r.samples,[]);
    }
  }
});

test('double-maximum combat stats stay exact while a near-maximum partner alone can vary',()=>{
  for(const [specialization,crit] of [[120,120],[120,118]]){
    const s=buildBaseBraceletSearch(combatTarget(specialization,crit));
    assert.deepEqual(s.rules.map(r=>[r.name,r.min,r.max]),crit===120
      ? [['치명',120,120],['특화',120,120]] : [['치명',116,120],['특화',120,120]]);
    const x=item();x.Options[0].Value=120;x.Options[1].Value=crit===120?120:116;
    assert.equal(normalizeBaseBraceletAuction(page([x]),s,{now:NOW}).status,'ok');
    x.Options[0].Value=119;
    assert.equal(normalizeBaseBraceletAuction(page([x]),s,{now:NOW}).status,'unavailable');
    x.Options[0].Value=120;x.Options[1].Value=crit===120?119:115;
    assert.equal(normalizeBaseBraceletAuction(page([x]),s,{now:NOW}).status,'unavailable');
  }
});

test('primary attributes vitality and supported special effects keep exact values',()=>{
  for(const row of [
    {fixed:true,text:'힘 +12000',id:'base.mainStat',value:12000},
    {fixed:true,text:'체력 +5000',id:'base.vitality',value:5000},
    {fixed:true,text:'최대 생명력 +14000',id:'special.maxHp',tier:2},
  ]){
    const e=target();e.target[0]=row;const s=buildBaseBraceletSearch(e),r=s.rules.find(r=>r.id===row.id);
    assert.equal(s.status,'ok');assert.equal(r.min,r.value);assert.equal(r.max,r.value);
    assert.equal(r.operator,'=');assert.equal(r.tolerance,0);
    const x=item();x.Options[0]={Type:r.types[0],IsValuePercentage:false,OptionName:r.name,Value:r.value};
    assert.equal(normalizeBaseBraceletAuction(page([x]),s,{now:NOW}).status,'ok');
    for(const delta of [-1,1]){
      x.Options[0].Value=r.value+delta;
      assert.equal(normalizeBaseBraceletAuction(page([x]),s,{now:NOW}).status,'unavailable');
    }
  }
});

function planTarget(rows){const e=target();e.target.splice(0,2,...rows);return e;}
test('search plan relaxes a combat plus main-stat bracelet to an any-value main stat without a duplicate stage',()=>{
  const e=planTarget([{fixed:true,text:'특화 +100',id:'combat.specialization',value:100},{fixed:true,text:'민첩 +12000',id:'base.mainStat',value:12000}]);
  const before=JSON.stringify(e),plan=buildBaseBraceletSearchPlan(e);
  assert.equal(plan.status,'ok');assert.equal(JSON.stringify(e),before);
  // Two fixed slots leave nothing for 'stats-only' to drop here, so it collapses into the exact stage.
  assert.deepEqual(plan.stages.map(stage=>stage.relaxation),['none','stats-only-main-any']);
  assert.equal(new Set(plan.stages.map(stage=>stage.fingerprint)).size,2);
  assert.equal(plan.stages[0].fingerprint,buildBaseBraceletSearch(e).fingerprint);
  const [none,mainAny]=plan.stages;
  assert.deepEqual(none.body.EtcOptions,[{FirstOption:1,SecondOption:11,MinValue:12000,MaxValue:12000},{FirstOption:2,SecondOption:16,MinValue:95,MaxValue:105},{FirstOption:4,SecondOption:1,MinValue:2,MaxValue:2},{FirstOption:4,SecondOption:2,MinValue:2,MaxValue:2}]);
  const range=mainAny.rules.find(rule=>rule.id==='base.mainStat').allowedRange;
  assert.ok(range[0]<12000&&range[1]>12000);
  assert.deepEqual(mainAny.body.EtcOptions[0],{FirstOption:1,SecondOption:11,MinValue:range[0],MaxValue:range[1]});
  assert.deepEqual(mainAny.conditions,[{name:'민첩',operator:'any',value:12000,min:range[0],max:range[1],tolerance:0,used:true},{name:'특화',operator:'range',value:100,min:95,max:105,tolerance:5,used:true}]);
  const x=item();x.Options[1]={Type:'STAT',IsValuePercentage:false,OptionName:'힘 / 민첩 / 지능',Value:range[1]};
  assert.equal(normalizeBaseBraceletAuction(page([x]),mainAny,{now:NOW}).status,'ok');
  assert.equal(normalizeBaseBraceletAuction(page([x]),none,{now:NOW}).status,'unavailable');
  x.Options[1].Value=range[1]+1;assert.equal(normalizeBaseBraceletAuction(page([x]),mainAny,{now:NOW}).status,'unavailable');
});
test('search plan drops vitality and special effects from the relaxed stages while listings keep them',()=>{
  const e=planTarget([{fixed:true,text:'치명 +95',id:'combat.crit',value:95},{fixed:true,text:'체력 +5000',id:'base.vitality',value:5000}]);
  const plan=buildBaseBraceletSearchPlan(e);
  assert.deepEqual(plan.stages.map(stage=>stage.relaxation),['none','stats-only']);
  const relaxed=plan.stages[1];
  assert.deepEqual(relaxed.body.EtcOptions,[{FirstOption:2,SecondOption:15,MinValue:90,MaxValue:100},{FirstOption:4,SecondOption:1,MinValue:2,MaxValue:2},{FirstOption:4,SecondOption:2,MinValue:2,MaxValue:2}]);
  assert.deepEqual(relaxed.conditions,[{name:'체력',operator:'any',value:5000,min:null,max:null,tolerance:0,used:false},{name:'치명',operator:'range',value:95,min:90,max:100,tolerance:5,used:true}]);
  const x=item();x.Options[0]={Type:'STAT',IsValuePercentage:false,OptionName:'체력',Value:4000};
  assert.equal(normalizeBaseBraceletAuction(page([x]),plan.stages[0],{now:NOW}).status,'unavailable');
  assert.equal(normalizeBaseBraceletAuction(page([x]),relaxed,{now:NOW}).status,'ok');
  const special=planTarget([{fixed:true,text:'특화 +100',id:'combat.specialization',value:100},{fixed:true,text:'최대 생명력 +14000',id:'special.maxHp',tier:2}]);
  const specialPlan=buildBaseBraceletSearchPlan(special);
  assert.deepEqual(specialPlan.stages.map(stage=>stage.relaxation),['none','stats-only']);
  assert.ok(!specialPlan.stages[1].body.EtcOptions.some(option=>option.FirstOption===5));
  assert.equal(specialPlan.stages[1].conditions.find(row=>row.name==='최대 생명력').used,false);
});
test('search plan collapses to the exact stage for combat-only bracelets and for vitality plus special effect',()=>{
  const combatOnly=buildBaseBraceletSearchPlan(target());
  assert.equal(combatOnly.stages.length,1);assert.equal(combatOnly.stages[0].relaxation,'none');
  assert.deepEqual(combatOnly.stages[0].body,buildBaseBraceletSearch(target()).body);
  const noCore=buildBaseBraceletSearchPlan(planTarget([{fixed:true,text:'체력 +5000',id:'base.vitality',value:5000},{fixed:true,text:'최대 생명력 +14000',id:'special.maxHp',tier:2}]));
  assert.equal(noCore.stages.length,1);assert.equal(noCore.stages[0].relaxation,'none');
  assert.deepEqual(noCore.stages[0].body.EtcOptions.slice(0,2),[{FirstOption:1,SecondOption:6,MinValue:5000,MaxValue:5000},{FirstOption:5,SecondOption:3,MinValue:14000,MaxValue:14000}]);
  const mainStat=buildBaseBraceletSearchPlan(planTarget([{fixed:true,text:'민첩 +12000',id:'base.mainStat',value:12000},{fixed:true,text:'체력 +5000',id:'base.vitality',value:5000}]));
  assert.deepEqual(mainStat.stages.map(stage=>stage.relaxation),['none','stats-only','stats-only-main-any']);
  assert.equal(buildBaseBraceletSearchPlan({...target(),rarity:'mythic'}).status,'unavailable');
});
test('search plan skips an availability-only exact stage when a relaxed stage exists',()=>{
  const e=planTarget([{fixed:true,text:'공격 및 이동 속도가 6% 증가한다.',id:'special.attackMoveSpeed',tier:3},{fixed:true,text:'특화 +100',id:'combat.specialization',value:100}]);
  assert.equal(buildBaseBraceletSearchPlan(e).reason,'fixed_special_value_unverified');
  const plan=buildBaseBraceletSearchPlan(e,{checkAvailability:true});
  assert.deepEqual(plan.stages.map(stage=>stage.relaxation),['stats-only']);
  assert.equal(plan.stages[0].availabilityOnly,undefined);
  assert.ok(!plan.stages[0].body.EtcOptions.some(option=>option.FirstOption===5));
  const alone=buildBaseBraceletSearchPlan(planTarget([{fixed:true,text:'공격 및 이동 속도가 6% 증가한다.',id:'special.attackMoveSpeed',tier:3},{fixed:true,text:'체력 +5000',id:'base.vitality',value:5000}]),{checkAvailability:true});
  assert.deepEqual(alone.stages.map(stage=>[stage.relaxation,stage.availabilityOnly]),[['none',true]]);
});

test('relaxed stages exclude listings whose open slot holds another core option and count them separately',()=>{
  const plan=buildBaseBraceletSearchPlan(planTarget([{fixed:true,text:'특화 +100',id:'combat.specialization',value:100},{fixed:true,text:'체력 +5000',id:'base.vitality',value:5000}]));
  assert.deepEqual(plan.stages.map(stage=>stage.relaxation),['none','stats-only']);
  const relaxed=plan.stages[1];
  const listing=(price,option)=>{const x=item(price);x.Options[1]=option;return x;};
  const stat=(name,value)=>({Type:'STAT',IsValuePercentage:false,OptionName:name,Value:value});
  const r=normalizeBaseBraceletAuction({PageNo:1,PageSize:10,TotalCount:5,Items:[
    listing(100,stat('치명',95)),listing(200,stat('힘 / 민첩 / 지능',12000)),listing(300,stat('체력',4100)),
    listing(400,{Type:'BRACELET_SPECIAL_EFFECTS',IsValuePercentage:false,OptionName:'최대 생명력',Value:14000}),listing(500,stat('민첩',12000)),
  ]},relaxed,{now:NOW});
  assert.equal(r.status,'ok');assert.deepEqual(r.samples.map(sample=>sample.price),[300,400]);
  assert.equal(r.coreMismatchCount,3);assert.equal(r.excludedCount,0);assert.equal(r.checkedCount,5);
  const expired=listing(50,stat('체력',4100));expired.AuctionInfo.EndDate='2026-09-15T12:00:00';
  const mixed=normalizeBaseBraceletAuction(page([expired,listing(100,stat('치명',95))]),relaxed,{now:NOW});
  assert.equal(mixed.status,'ok');assert.deepEqual(mixed.samples,[]);assert.equal(mixed.excludedCount,1);assert.equal(mixed.coreMismatchCount,1);
  const exact=normalizeBaseBraceletAuction(page([listing(100,stat('체력',5000))]),plan.stages[0],{now:NOW});
  assert.equal(exact.status,'ok');assert.equal(exact.coreMismatchCount,0);assert.equal(exact.samples.length,1);
  assert.equal(normalizeBaseBraceletAuction(page([listing(100,stat('치명',95))]),plan.stages[0],{now:NOW}).status,'unavailable');
});
test('main stat plus a priced special effect relaxes in three stages down to any main-stat value',()=>{
  const plan=buildBaseBraceletSearchPlan(planTarget([{fixed:true,text:'지능 +12000',id:'base.mainStat',value:12000},{fixed:true,text:'물리 방어력 +5000',id:'special.physicalDefense',tier:1}]));
  assert.deepEqual(plan.stages.map(stage=>stage.relaxation),['none','stats-only','stats-only-main-any']);
  assert.equal(new Set(plan.stages.map(stage=>stage.fingerprint)).size,3);
  assert.deepEqual(plan.stages.map(stage=>stage.body.EtcOptions.slice(0,-2)),[
    [{FirstOption:1,SecondOption:11,MinValue:12000,MaxValue:12000},{FirstOption:5,SecondOption:1,MinValue:5000,MaxValue:5000}],
    [{FirstOption:1,SecondOption:11,MinValue:12000,MaxValue:12000}],
    [{FirstOption:1,SecondOption:11,MinValue:9600,MaxValue:16000}]]);
  assert.deepEqual(plan.stages[2].conditions,[{name:'지능',operator:'any',value:12000,min:9600,max:16000,tolerance:0,used:true},{name:'물리 방어력',operator:'any',value:5000,min:null,max:null,tolerance:0,used:false}]);
  const x=item();x.Options[0]={Type:'STAT',IsValuePercentage:false,OptionName:'지능',Value:15000};x.Options[1]={Type:'STAT',IsValuePercentage:false,OptionName:'특화',Value:100};
  const r=normalizeBaseBraceletAuction(page([x]),plan.stages[2],{now:NOW});
  assert.equal(r.status,'ok');assert.deepEqual(r.samples,[]);assert.equal(r.coreMismatchCount,1);
  x.Options[1]={Type:'STAT',IsValuePercentage:false,OptionName:'체력',Value:4100};
  assert.equal(normalizeBaseBraceletAuction(page([x]),plan.stages[2],{now:NOW}).samples.length,1);
});
