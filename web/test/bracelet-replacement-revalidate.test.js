import test from 'node:test';
import assert from 'node:assert/strict';
import {buildBraceletReplacementPlan, normalizeBraceletReplacementAuction} from '../../src/bracelet-replacement-search.js';
import {createBraceletValueService} from '../src/bracelet-value.js';
import {buildBaseBraceletSearch, normalizeBaseBraceletAuction} from '../../src/bracelet-base-price.js';

const now = Date.parse('2026-09-23T00:00:00Z');
const stat = (OptionName, Value) => ({Type:'STAT', OptionName, Value, IsPenalty:false, IsValuePercentage:false});
const input = {tier:4, grade:'고대', stats:[{name:'치명',value:90},{name:'특화',value:90}]};
const stages = buildBraceletReplacementPlan(input).stages;
const listing = (Options, BuyPrice=100) => ({Name:'찬란한 구원자의 팔찌', Tier:4, Grade:'고대', Options,
  AuctionInfo:{BuyPrice,EndDate:'2099-01-01T00:00:00Z'}});
const page = Items => ({PageNo:1,PageSize:10,TotalCount:Items.length,Items});
const normalize = (options, search=stages[0]) => normalizeBraceletReplacementAuction(page([listing(options)]),search,{now});
const pair = (crit=90,spec=90) => [stat('치명',crit),stat('특화',spec)];

test('요청한 특성 범위의 양 끝과 정확한 값은 허용한다',()=>{
  for(const value of [85,90,95]) assert.equal(normalize(pair(value,value)).status,'ok');
});

test('특성이 없거나 요청 범위보다 작거나 크면 표본 전체를 거절한다',()=>{
  for(const options of [[stat('제압',90)],[stat('치명',90)],pair(84),pair(96)]) {
    const result=normalizeBraceletReplacementAuction(page([listing(pair()),listing(options,200)]),stages[0],{now});
    assert.equal(result.status,'unavailable');assert.equal(result.reason,'filter_mismatch');
    assert.deepEqual(result.samples,[]);
  }
});

test('완화 단계는 남아 있는 요청 조건만 검사하고 제거한 특성은 요구하지 않는다',()=>{
  const search=stages[1];
  assert.equal(search.rules.length,1);
  const result=normalize([stat(search.rules[0].name,90)],search);
  assert.equal(result.status,'ok');assert.equal(result.samples[0].price,100);
  assert.equal(normalize([stat('제압',90)],stages[2]).status,'ok');
});

test('특성만 요청했으면 특수 효과 부재와 추가 비요청 효과는 허용한다',()=>{
  assert.equal(normalize(pair()).status,'ok');
  assert.equal(normalize([...pair(),{Type:'BRACELET_SPECIAL_EFFECTS',OptionName:'순환',Value:1,IsPenalty:false,IsValuePercentage:true}]).status,'ok');
});

test('주스탯은 개별 이름과 공식 통합 이름을 허용하고 다른 주스탯이나 다른 값은 거절한다',()=>{
  const search=buildBraceletReplacementPlan({tier:4,grade:'고대',stats:[{name:'힘',value:10000}]}).stages[0];
  for(const name of ['힘','힘 / 민첩 / 지능']) assert.equal(normalize([stat(name,10000)],search).status,'ok');
  for(const options of [[stat('지능',10000)],[stat('힘',9999)],[stat('힘',10001)],
    [stat('힘',10000),stat('힘 / 민첩 / 지능',10000)]]) {
    assert.equal(normalize(options,search).status,'unavailable');
  }
});

test('주스탯 통합 이름은 전투 특성을 대신하지 않는다',()=>{
  const search=buildBraceletReplacementPlan({tier:4,grade:'고대',stats:[{name:'치명',value:90}]}).stages[0];
  assert.equal(normalize([stat('힘 / 민첩 / 지능',90)],search).reason,'filter_mismatch');
});

test('기준 정규화기가 허용한 슬롯 빈 이름·겹친 이름과 도약은 대체 검색도 허용한다',()=>{
  const baseSearch=buildBaseBraceletSearch({status:'ok',rarity:'ancient',fixedCount:2,grantedCount:2,target:[
    {fixed:true,text:'치명 +90',id:'combat.crit',value:90},
    {fixed:true,text:'특화 +90',id:'combat.specialization',value:90},
    {fixed:false,text:'적에게 주는 피해가 2.00% 증가한다.',id:'special.damage',tier:1},
    {fixed:false,text:'추가 피해 +3.00%',id:'special.additionalDamage',tier:1},
  ]});
  assert.equal(baseSearch.status,'ok');
  for(const [randomName,fixedName] of [['부여 효과 수량',''],['부여 효과 수량','치명'],['부여 효과 수량','도약'],['','']]) {
    const item=listing([...pair(),{Type:'BRACELET_RANDOM_SLOT',OptionName:randomName,Value:2},
      {Type:'BRACELET_FIXED_SLOT',OptionName:fixedName,Value:2},{Type:'ARK_PASSIVE',OptionName:'도약',Value:18}]);
    item.AuctionInfo.TradeAllowCount=1;
    const response=page([item]);
    assert.equal(normalizeBaseBraceletAuction(response,baseSearch,{now}).status,'ok');
    assert.equal(normalizeBraceletReplacementAuction(response,stages[0],{now}).status,'ok');
  }
});

test('슬롯·도약은 이름이 달라도 같은 타입이 두 개면 거절한다',()=>{
  for(const Type of ['BRACELET_RANDOM_SLOT','BRACELET_FIXED_SLOT','ARK_PASSIVE']) {
    const names=Type==='ARK_PASSIVE'?['도약','도약']:['수량 A','수량 B'];
    const options=[...pair(),...names.map(OptionName=>({Type,OptionName,Value:2}))];
    assert.equal(normalize(options).status,'unavailable');
  }
});

test('잘못된 Options는 조건 없는 단계에서도 가격으로 사용하지 않는다',()=>{
  for(const options of [undefined,null,{},[null],[{...stat('치명',90),Value:'90'}],
    [{...stat('치명',90),Value:NaN}],[{...stat('치명',90),Value:-1}],
    [{...stat('치명',90),Type:'UNKNOWN'}],[{...stat('치명',90),OptionName:null}],
    Array.from({length:13},()=>stat('치명',90))]) {
    assert.equal(normalize(options,stages[2]).status,'unavailable');
  }
});

test('요청 특성은 정수 절대값이며 중복·백분율·페널티·다른 타입은 거절한다',()=>{
  for(const invalid of [
    [...pair(),stat('치명',90)],pair(90.5),[{...stat('치명',90),IsValuePercentage:true},stat('특화',90)],
    [{...stat('치명',90),IsPenalty:true},stat('특화',90)],
    [{...stat('치명',90),Type:'BRACELET_SPECIAL_EFFECTS'},stat('특화',90)],
    [{Type:'STAT',OptionName:'치명',Value:90},stat('특화',90)]]) {
    assert.equal(normalize(invalid).status,'unavailable');
  }
});

test('필터 불일치는 서비스 502로 끝나며 다음 완화 단계나 추가 API 호출로 숨기지 않는다',async t=>{
  let calls=0;
  const app=createBraceletValueService({config:{automaticApproval:{lostArkApiKey:'synthetic-bracelet-key'}},now:()=>now,
    fetchImpl:async()=>{calls++;return new Response(JSON.stringify(page([listing([stat('제압',90)])])),{headers:{'Content-Type':'application/json'}});}});
  t.after(()=>app.close());
  await assert.rejects(app.replacement(input),{status:502,message:'bracelet_value_unavailable'});
  assert.equal(calls,1);
});
