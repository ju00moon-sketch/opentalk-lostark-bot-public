import test from 'node:test';
import assert from 'node:assert/strict';
import { createValuationPriceService } from '../src/valuation-prices.js';

const marketQuote = { quoteKey: 'book-a', kind: 'market', category: 40000, name: '원한 각인서', grade: '유물' };
const syntheticConfig={automaticApproval:{lostArkApiKey:'test-only'}};
const accessoryQuote=code=>({quoteKey:`accessory-${code}`,kind:'auction',body:{CategoryCode:200010,ItemName:'',ItemTier:4,ItemGrade:'고대',ItemGradeQuality:80,
  EtcOptions:[{FirstOption:7,SecondOption:code,MinValue:code===42?200:160,MaxValue:code===42?200:160}],SkillOptions:[]}});

test('official accessory aliases retain their option kind and percentage unit',async()=>{
  for(const [code,name,value]of [[43,'세레나데, 신앙, 조화 게이지 획득량 증가',1.6],[42,'적에게 주는 피해 증가',2]]){
    for(const change of [{},{Type:'STAT'},{IsValuePercentage:false},{IsPenalty:true},{Value:value+.1}]){
      const service=createValuationPriceService({config:syntheticConfig,now:()=>1000,fetchImpl:async()=>Response.json({PageNo:1,PageSize:10,TotalCount:1,Items:[{
        Name:'도래한 결전의 목걸이',Grade:'고대',Tier:4,GradeQuality:92,AuctionInfo:{BuyPrice:10,EndDate:'2099-01-01T00:00:00'},
        Options:[{Type:'ACCESSORY_UPGRADE',OptionName:name,Value:value,IsValuePercentage:true,IsPenalty:false,...change}],
      }]})});
      // A listing whose effect does not match exactly never satisfies the original search; it can only be
      // reached once the ladder has dropped that effect, and then it is marked as a replacement.
      const exact=!Object.keys(change).length;
      try{const result=await service.get(accessoryQuote(code));assert.equal(result.status,'ok');assert.equal(result.unitGold,10);
        assert.equal(result.basis,exact?'current_matching_listing_minimum':'replacement_relaxed_options');
        assert.equal(result.estimated===true,!exact);}
      finally{service.close();}
    }
  }
});

test('tier three ordinary gems preserve the requested tier while accessories remain tier four',async()=>{
  let sent;
  const service=createValuationPriceService({config:syntheticConfig,now:()=>1000,fetchImpl:async(_url,init)=>{sent=JSON.parse(init.body);return Response.json({PageNo:1,PageSize:10,TotalCount:1,Items:[
    {Name:'10레벨 멸화의 보석',Grade:'유물',Tier:3,AuctionInfo:{BuyPrice:1234,EndDate:'2099-01-01T00:00:00'}},
  ]});}});
  try{
    const quote={quoteKey:'tier3',kind:'auction',body:{CategoryCode:210000,ItemName:'10레벨 멸화의 보석',ItemTier:3,ItemGrade:'유물',EtcOptions:[],SkillOptions:[]}};
    assert.equal((await service.get(quote)).unitGold,1234);assert.equal(sent.ItemTier,3);
    await assert.rejects(service.get({...accessoryQuote(42),body:{...accessoryQuote(42).body,ItemTier:3}}),error=>error.status===400);
  }finally{service.close();}
});

test('percentage and flat attack effects remain distinct and duplicated same-unit effects are refused',async()=>{
  const percent={Type:'ACCESSORY_UPGRADE',OptionName:'공격력 ',Value:.4,IsValuePercentage:true,IsPenalty:false};
  const flat={...percent,Value:80,IsValuePercentage:false};
  for(const options of [[percent,flat],[percent,percent,flat]]){
    const service=createValuationPriceService({config:syntheticConfig,now:()=>1000,fetchImpl:async()=>Response.json({PageNo:1,PageSize:10,TotalCount:1,Items:[{
      Name:'도래한 결전의 귀걸이',Grade:'고대',Tier:4,GradeQuality:90,Options:options,AuctionInfo:{BuyPrice:100,EndDate:'2099-01-01T00:00:00'},
    }]})});
    try{
      const quote={quoteKey:'attack-units',kind:'auction',body:{CategoryCode:200020,ItemTier:4,ItemGrade:'고대',ItemGradeQuality:80,ItemName:'',
        EtcOptions:[{FirstOption:7,SecondOption:45,MinValue:40,MaxValue:40},{FirstOption:7,SecondOption:53,MinValue:80,MaxValue:80}],SkillOptions:[]}};
      const result=await service.get(quote);assert.equal(result.status,'ok');
      // Two same-unit effects cannot identify one option, so that listing is only reached as a replacement.
      assert.equal(result.estimated===true,options.length!==2);
    }finally{service.close();}
  }
});

test('normal-grade destruction and protection materials use observed bundle units',async()=>{
  const service=createValuationPriceService({market:{search:async()=>({pageCount:1,updatedAt:1000,items:[{name:'운명의 파괴석',grade:'일반',currentMinPrice:31,bundleCount:10}]})},now:()=>1000});
  try{assert.equal((await service.get({quoteKey:'material',kind:'market',category:50010,name:'운명의 파괴석',grade:'일반'})).unitGold,3.1);}finally{service.close();}
});
test('market quotes match exact identity, normalize units, and share concurrent work', async () => {
  let calls = 0;
  const service = createValuationPriceService({ market: { search: async () => {
    calls++; return { pageCount: 1, updatedAt: 1000, items: [
      { name: '전설 원한 각인서', grade: '전설', currentMinPrice: 2, bundleCount: 1 },
      { name: '유물 원한 각인서', grade: '유물', currentMinPrice: 1000, bundleCount: 10 },
      { name: '원한 각인서', grade: '유물', currentMinPrice: 1, bundleCount: 1 },
      { name: '전설 원한 각인서', grade: '유물', currentMinPrice: 1, bundleCount: 1 },
    ] };
  } }, now: () => 1000 });
  const [a, b] = await Promise.all([service.get(marketQuote), service.get(marketQuote)]);
  assert.equal(calls, 1); assert.equal(a.unitGold, 100); assert.deepEqual(a, b);
  service.close();
});
test('gem market catalogue distinguishes absent and unpriced grades without guessing', async () => {
  const service = createValuationPriceService({ market: { search: async () => ({ pageCount: 1, updatedAt: 1000, items: [
    { name: '질서의 젬 : 안정', grade: '영웅', currentMinPrice: 7777, bundleCount: 1, id: 67400003 },
    { name: '질서의 젬 : 안정 상자', grade: '영웅', currentMinPrice: 1, bundleCount: 1 },
    { name: '혼돈의 젬 : 침식', grade: '영웅', currentMinPrice: null, bundleCount: 1 },
  ] }) }, now: () => 1000 });
  const data = await service.gemCatalogue();
  assert.equal(data.prices['안정:영웅'].unitGold, 7777);
  assert.equal(data.prices['침식:영웅'].status, 'unavailable');
  assert.equal(data.prices['불변:고급'].status, 'unavailable');
  assert.equal(data.prices['안정 상자:영웅'], undefined);
  service.close();
});
test('unknown, missing and zero market quotes do not become zero value', async () => {
  const service = createValuationPriceService({ market: { search: async () => ({ pageCount: 1, items: [
    { name: '유물 원한 각인서', grade: '유물', currentMinPrice: 0, bundleCount: 1 },
  ] }) } });
  const value = await service.get(marketQuote);
  assert.equal(value.status, 'unavailable'); assert.equal(value.unitGold, null);
  await assert.rejects(service.get({ ...marketQuote, category: 0 }), /invalid/);
  service.close();
});
test('auction quotes inspect matching active buyout listings and preserve observed time', async () => {
  let calls = 0;
  const service = createValuationPriceService({ config: { automaticApproval: { lostArkApiKey: 'test-only' } }, now: () => 1000,
    fetchImpl: async (_url, init) => {
      calls++; assert.equal(init.redirect, 'error'); assert.equal(JSON.parse(init.body).CategoryCode, 210000);
      return Response.json({ PageNo: 1, PageSize: 10, TotalCount: 3, Items: [
        { Name: '9레벨 겁화의 보석', Grade: '전설', Tier: 4, AuctionInfo: { BuyPrice: 1, EndDate: '2099-01-01T00:00:00' } },
        { Name: '10레벨 겁화의 보석', Grade: '유물', Tier: 4, AuctionInfo: { BuyPrice: 200, EndDate: '2099-01-01T00:00:00' } },
        { Name: '10레벨 겁화의 보석', Grade: '유물', Tier: 4, AuctionInfo: { BuyPrice: 300, EndDate: '2099-01-01T00:00:00' } },
      ] });
    } });
  const quote = { quoteKey: 'gem-10', kind: 'auction', body: { CategoryCode: 210000, ItemName: '10레벨 겁화의 보석', ItemTier: 4, ItemGrade: '유물', ItemGradeQuality: null, EtcOptions: [], SkillOptions: [] } };
  const result = await service.get(quote);
  assert.equal(result.unitGold, 200); assert.equal(result.checkedAt, 1000); assert.equal(calls, 1);
  service.close();
});
test('malformed, slow and rate-limited auction responses stay unavailable and close cancels work', async () => {
  const quote = { quoteKey: 'gem-10', kind: 'auction', body: { CategoryCode: 210000, ItemName: '10레벨 겁화의 보석', ItemTier: 4, ItemGrade: '유물', EtcOptions: [], SkillOptions: [] } };
  for (const response of [Response.json({}, { status: 429 }), Response.json({ Items: [] }), new Response('<html>', { headers: { 'content-type': 'text/html' } })]) {
    const service = createValuationPriceService({ config: { automaticApproval: { lostArkApiKey: 'test-only' } }, fetchImpl: async () => response });
    await assert.rejects(service.get(quote)); service.close();
  }
  const service = createValuationPriceService({ config: { automaticApproval: { lostArkApiKey: 'test-only' } }, requestTimeoutMs: 15,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('aborted')), { once: true })) });
  await assert.rejects(service.get(quote)); service.close();
  await assert.rejects(service.get(quote));
});
