import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSupportEfficiency, isSupportCharacter } from '../src/native-support-efficiency.js';
import * as support from '../src/native-support-efficiency.js';
import { analyzeNativeEfficiency } from '../src/native-character-efficiency.js';

const tip = parts => JSON.stringify(Object.fromEntries(parts.map(([title, body], i) => ['Element_'+i,{ type:'ItemPartBox',value:{Element_000:title,Element_001:body}}])));
function item(Type, basic, extra = []) { return {Type,Grade:'고대',Tooltip:tip([['기본 효과',basic],...extra])}; }
function fixture(option='공격적중시20.0%확률로적에게주는피해가1.2%증가한다.') {
  const bangle={Type:'팔찌',Grade:'고대',Tooltip:JSON.stringify({title:{type:'ItemTitle',value:{leftStr2:'아이템 티어 4'}},effect:{type:'ItemPartBox',value:{Element_000:'팔찌 효과',Element_001:"<img src='emoticon_tooltip_bracelet_locked'></img>신속 +100<br><img src='emoticon_tooltip_bracelet_changeable'></img>"+option}}})};
  const nodes=[['진화','정열의 춤사위',2],['진화','선각자',1],['진화','기원',1],['진화','입식 타격가',2],['깨달음','만개',3],['깨달음','묵법 : 접무',3]];
  return {ArmoryProfile:{CharacterClassName:'도화가',Stats:[{Type:'특화',Value:'600'},{Type:'신속',Value:'1800'}]},
    ArmoryEquipment:[...['투구','상의','하의','장갑','어깨'].map(type=>item(type,'지능 +100000')),item('무기','무기 공격력 +200000'),item('완갑','지능 +30000<br>무기 공격력 +10000<br>기본 공격력 +1000'),...['목걸이','귀걸이','귀걸이','반지','반지'].map(type=>item(type,'지능 +20000',[['연마 효과','']])),item('어빌리티 스톤','체력 +20000'),bangle],ArmoryAvatars:[],
    ArmoryEngraving:{ArkPassiveEffects:[{Name:'마나의 흐름',Grade:'유물',Level:4,AbilityStoneLevel:null},{Name:'각성',Grade:'유물',Level:4,AbilityStoneLevel:2}]},
    ArkPassive:{Effects:nodes.map(([Name,name,level])=>({Name,Description:`${Name} 2티어 ${name} Lv.${level}`})),Points:[{Name:'깨달음',Description:'6랭크 30레벨'},{Name:'진화',Description:'6랭크 20레벨'}]},
    ArmorySkills:[{Name:'묵법 : 해우물',Level:10,Tripods:[{Name:'빠른 준비',IsSelected:true}]}],ArmoryGem:{Gems:null,Effects:{Description:'',Skills:[]}},ArkGrid:{Slots:[],Effects:[]}};
}

test('support classification requires class-compatible selected awakening node',()=>{const raw=fixture();assert.equal(isSupportCharacter(raw),true);raw.ArkPassive.Effects=raw.ArkPassive.Effects.filter(x=>!x.Description.includes('만개'));assert.equal(isSupportCharacter(raw),false);raw.ArmoryProfile.CharacterClassName='블레이드';raw.ArkPassive.Effects.push({Name:'깨달음',Description:'깨달음 2티어 만개 Lv.3'});assert.equal(isSupportCharacter(raw),false);assert.equal(isSupportCharacter(null),false)});

test('unknown complete bracelet descriptions never become a zero or full efficiency',()=>{const x=analyzeSupportEfficiency(fixture());assert.equal(x.bracelet.status,'unavailable');assert.equal(x.bracelet.efficiency,null);assert(x.bracelet.omitted.length)});

test('official no-gem shape remains valid and empty ArkGrid is absent',()=>{const raw=fixture('최대 생명력 +14000');const x=analyzeSupportEfficiency(raw);assert.equal(x.bracelet.status,'ok');assert(x.bracelet.efficiency>0);assert.equal(x.gem.status,'absent');assert.equal(x.gem.efficiency,null)});

test('unrelated profile attack cannot affect modeled support attack or bracelet result',()=>{const a=fixture('최대 생명력 +14000'),b=structuredClone(a);a.ArmoryProfile.Stats.push({Type:'공격력',Value:'1'});b.ArmoryProfile.Stats.push({Type:'공격력',Value:'99999999'});assert.deepEqual(analyzeSupportEfficiency(a),analyzeSupportEfficiency(b))});

test('malformed, duplicate, mismatched gem slots fail closed',()=>{for(const slots of [[{GemSlot:1,Name:'묵법 : 해그리기',Description:['지원 효과 9.00 % 증가'],Option:'기본 공격력 1% 증가'}],[{GemSlot:0,Name:'묵법 : 해그리기',Description:['지원 효과 9.00 % 증가'],Option:'기본 공격력 1% 증가'},{GemSlot:0,Name:'묵법 : 해우물',Description:['지원 효과 9.00 % 증가'],Option:'기본 공격력 1% 증가'}]]){const raw=fixture('최대 생명력 +14000');raw.ArmoryGem={Gems:[{Slot:0,Level:9,Grade:'전설'}],Effects:{Description:'기본 공격력 총합 : 1%',Skills:slots}};const x=analyzeSupportEfficiency(raw);assert.equal(x.bracelet.status,'unavailable')}});

test('missing official prerequisite cannot be accepted as a calculated value',()=>{for(const field of ['ArmorySkills','ArkPassive','ArmoryGem']){const raw=fixture('최대 생명력 +14000');delete raw[field];const x=analyzeSupportEfficiency(raw);assert.notEqual(x.bracelet.status,'ok');assert.equal(x.bracelet.efficiency,null)}});

test('input structures and tooltips remain unchanged',()=>{const raw=fixture('최대 생명력 +14000'),snapshot=structuredClone(raw);analyzeSupportEfficiency(raw);assert.deepEqual(raw,snapshot)});

export { fixture };

test('vitality and explicit null grid collections retain a support bracelet comparison', () => {
  const raw = fixture('체력 +4760');
  raw.ArkGrid = { Slots: null, Effects: null };
  const actual = analyzeSupportEfficiency(raw);
  assert.equal(actual.bracelet.status, 'ok');
  assert.equal(actual.bracelet.efficiency, analyzeSupportEfficiency(fixture('최대 생명력 +14000')).bracelet.efficiency);
  assert.equal(actual.gem.status, 'absent');
  for (const grid of [{ Slots: null }, { Effects: null }, { Slots: [] }, {}]) {
    assert.equal(analyzeSupportEfficiency({ ...raw, ArkGrid: grid }).bracelet.status, 'unavailable', JSON.stringify(grid));
  }
});

test('official support effect labels and scoped core-point tooltip are accepted',()=>{const raw=fixture('최대 생명력 +14000');raw.ArkGrid={Slots:[{Index:3,Name:'혼돈의 해 코어 : 신념의 강화',Grade:'고대',Point:20,Gems:[{Index:0,IsActive:true,Tooltip:tip([['젬 기본 정보','젬 타입 : 혼돈<br>젬 포인트 : 19'],['젬 효과','필요 의지력 : 3<br>혼돈 포인트 : <font>5</font><br>[낙인력] Lv.5']])}]}],Effects:[{Name:'아군 피해 강화',Level:43,Tooltip:"아군 피해량 강화 효과 <font>+2.25%</font>"},{Name:'아군 공격 강화',Level:64,Tooltip:'아군 공격력 강화 효과 +8.32%'},{Name:'보스 피해',Level:5,Tooltip:'보스 등급 이상 몬스터에게 주는 피해 +0.41%'}]};const x=analyzeSupportEfficiency(raw);assert.equal(x.bracelet.status,'ok');assert.equal(x.gem.status,'ok');assert(x.gem.efficiency>0);assert(x.gem.optionEfficiency>0);assert(x.gem.pointEfficiency>0);assert.deepEqual(x.gem.pointBreakdown,[{coreName:'혼돈의 해 코어 : 신념의 강화',grade:'고대',beforePoint:17,afterPoint:20,gainedPoint:3}]);assert.equal(x.gem.effectEfficiencies.find(x=>x.name==='보스 피해').efficiency,0)});

test('malformed numeric gem descriptions and duplicate descriptions are rejected',()=>{for(const descriptions of [['재사용 대기시간 1..2% 감소'],['지원 효과 9.00% 증가','지원 효과 9.00% 증가'],['피해 4..0% 증가']]){const raw=fixture('최대 생명력 +14000');raw.ArmoryGem={Gems:[{Slot:0,Level:9}],Effects:{Description:'기본 공격력 총합 : 1%',Skills:[{GemSlot:0,Name:'묵법 : 해그리기',Description:descriptions}]}};assert.equal(analyzeSupportEfficiency(raw).bracelet.status,'unavailable')}});

test('explicit null ArkGrid and an unequipped bracelet remain explicit absences',()=>{const raw=fixture('최대 생명력 +14000');raw.ArkGrid=null;assert.equal(analyzeSupportEfficiency(raw).bracelet.status,'ok');assert.equal(analyzeSupportEfficiency(raw).gem.status,'absent');raw.ArkGrid={Slots:[],Effects:[{Name:'아군 공격 강화',Level:10,Tooltip:'아군 공격력 강화 효과 +1.30%'}]};raw.ArmoryEquipment=raw.ArmoryEquipment.filter(x=>x.Type!=='팔찌');const result=analyzeSupportEfficiency(raw);assert.equal(result.bracelet.status,'absent');assert.equal(result.gem.status,'ok');assert(result.gem.efficiency>0)});

test('independently expanded four buff scenarios match bracelet probability model',()=>{const raw=fixture('최대 생명력 +14000');function model(hasteInput){const h=(hasteInput+600)*.75,s=(hasteInput+600)*.25,attack=Math.floor(Math.sqrt(630000*(210000*1.03)/6)+1000),q=(1-.0214739*h/100)*.9*.95,u=14/Math.max(14,27*q,24*q),a=Math.floor(.22*attack*1.44),always=(170000+a*u)/170000*1.13*(1.59/1.45),c=.2005*(1+s/3020)*(1+(.15*(1/(.865*(1-.0214739*h/100)*.9)-1)))/q,m=.2445/q,id=1+.13*1.2*(1+s/2079.1),hyper=1.1;return c*m*always*id*hyper+c*(1-m)*always*id+m*(1-c)*always*hyper+(1-c)*(1-m)*always};const expected=Math.round((Math.floor(((model(1800)/model(1700))**4.24-1)*10000)/100/1.4)*10000)/10000;assert.equal(analyzeSupportEfficiency(raw).bracelet.efficiency,expected)});

test('a missing gem point tooltip does not discard a valid bracelet calculation',()=>{const raw=fixture('최대 생명력 +14000');raw.ArkGrid.Slots=[{Index:3,Name:'혼돈의 해 코어 : 신념의 강화',Grade:'고대',Point:20,Gems:[{Index:0,IsActive:true,Tooltip:tip([['젬 기본 정보','젬 포인트 : 19']])}]}];const x=analyzeSupportEfficiency(raw);assert.equal(x.bracelet.status,'ok');assert.equal(x.gem.status,'unavailable');assert.equal(x.gem.efficiency,null);assert(x.gem.omitted.length)});


test('duplicate or missing core indexes cannot be treated as valid core slots',()=>{for(const indexes of [[3,3],[undefined,4]]){const raw=fixture('최대 생명력 +14000');raw.ArkGrid.Slots=[{Index:indexes[0],Name:'혼돈의 해 코어 : 신념의 강화',Grade:'고대',Point:17,Gems:[]},{Index:indexes[1],Name:'혼돈의 달 코어 : 낙인의 흔적',Grade:'고대',Point:17,Gems:[]}];assert.equal(analyzeSupportEfficiency(raw).bracelet.status,'unavailable')}});

test('skill levels and selected flags are validated before cooldown decisions',()=>{for(const mutate of [s=>s.Level=-1,s=>s.Level=1.5,s=>s.Tripods=null,s=>s.Tripods[0].IsSelected='true']){const raw=fixture('최대 생명력 +14000');mutate(raw.ArmorySkills[0]);assert.equal(analyzeSupportEfficiency(raw).bracelet.status,'unavailable')}});

test('cores at 17P do not require irrelevant gem-point inputs',()=>{const raw=fixture('최대 생명력 +14000');raw.ArkGrid.Slots=[{Index:3,Name:'혼돈의 해 코어 : 신념의 강화',Grade:'고대',Point:17,Gems:null}];const x=analyzeSupportEfficiency(raw);assert.equal(x.bracelet.status,'ok');assert.equal(x.gem.status,'ok');assert.equal(x.gem.pointEfficiency,0)});

test('native entry dispatches selected support and preserves epoch zero',()=>{const raw=fixture('최대 생명력 +14000'),expected=analyzeSupportEfficiency(raw),actual=analyzeNativeEfficiency(raw,{now:0});assert.deepEqual(actual.bracelet,expected.bracelet);assert.deepEqual(actual.gem,expected.gem);assert.equal(actual.calculatedAt,0);assert.equal(actual.source,'official-api')});

test('support score reuses the verified four-scenario buff model at full precision',()=>{
  const raw=fixture('최대 생명력 +14000'),before=structuredClone(raw),efficiencyBefore=analyzeSupportEfficiency(raw);
  const result=support.evaluateNativeSupportScore(raw);
  // Independent expansion of the fixture's four buff uptime combinations.
  assert(Math.abs(result.factors.totalBuffPower-1.8372043763188217)<1e-12);
  assert(Math.abs(result.value-1582.008906500492)<1e-8);
  assert.deepEqual({...result.factors,totalBuffPower:0},{totalBuffPower:0,orderCore:1,exponent:4.24,scale:120});
  assert.deepEqual(result.missing,[]);assert(result.assumptions.length);
  assert.deepEqual(raw,before);assert.deepEqual(analyzeSupportEfficiency(raw),efficiencyBefore);
});

const supportOrderCore=(Index,Point,Grade='고대')=>({Index,Point,Grade,Gems:[],Name:[
  '질서의 해 코어 : 몽글몽글','질서의 달 코어 : 환영문짝','질서의 별 코어 : 붓 콩콩',
][Index]});

test('support order cores use their support grade tables and sun-moon pair rule',()=>{
  const tables={
    '고대':[[1.012,1.012,1.09,1.0918,1.093,1.0942],[1,1.006,1.03,1.031,1.032,1.033]],
    '유물':[[1.012,1.012,1.078,1.0798,1.081,1.0822],[1,1.006,1.021,1.022,1.023,1.024]],
  };
  for(const [grade,[main,star]] of Object.entries(tables))for(const [i,point] of [10,14,17,18,19,20].entries()){
    const raw=fixture('최대 생명력 +14000');raw.ArkGrid.Slots=[supportOrderCore(0,point,grade),supportOrderCore(1,point,grade),supportOrderCore(2,point,grade)];
    const result=support.evaluateNativeSupportScore(raw),expected=main[i]**2*star[i];
    assert.equal(result.factors.orderCore,expected);
    assert(Math.abs(result.value-1582.008906500492*expected)<1e-8);
    raw.ArkGrid.Slots=[supportOrderCore(0,point,grade)];
    assert.equal(support.evaluateNativeSupportScore(raw).factors.orderCore,main[0]);
  }
});

test('absent and non-table order points retain explicit neutral lookup behavior',()=>{
  const raw=fixture('최대 생명력 +14000');raw.ArkGrid=null;
  assert.equal(support.evaluateNativeSupportScore(raw).factors.orderCore,1);
  raw.ArkGrid={Slots:[supportOrderCore(0,13),supportOrderCore(1,16),supportOrderCore(2,9)],Effects:[]};
  assert.equal(support.evaluateNativeSupportScore(raw).factors.orderCore,1);
  raw.ArkGrid.Slots=[supportOrderCore(0,15)];
  assert.equal(support.evaluateNativeSupportScore(raw).factors.orderCore,1.012);
});

test('missing support prerequisites and invalid order slots never become a numeric score',()=>{
  for(const mutate of [raw=>{raw.ArmoryAvatars={}},raw=>raw.ArmoryProfile.CharacterClassName='블레이드',
    raw=>raw.ArkGrid.Slots=[supportOrderCore(0,20),{...supportOrderCore(0,20),Index:1,Name:'질서의 해 코어 : 햇살의 품'}],
    raw=>raw.ArkGrid.Slots=[{...supportOrderCore(0,20),Grade:'전설'}],
  ]){
    const raw=fixture('최대 생명력 +14000');mutate(raw);
    const result=support.evaluateNativeSupportScore(raw);
    assert.equal(result.value,null);assert.equal(result.factors,null);assert(result.missing.length);
  }
});
test('supporter gem efficiency follows the bracelet score convention',()=>{const raw=fixture('최대 생명력 +14000');raw.ArkGrid={Slots:[{Index:3,Name:'혼돈의 해 코어 : 신념의 강화',Grade:'고대',Point:20,Gems:[{Index:0,IsActive:true,Tooltip:tip([['젬 기본 정보','젬 타입 : 혼돈<br>젬 포인트 : 19'],['젬 효과','필요 의지력 : 3<br>혼돈 포인트 : <font>5</font><br>[낙인력] Lv.5']])}]}],Effects:[{Name:'아군 공격 강화',Level:64,Tooltip:'아군 공격력 강화 효과 +8.32%'}]};const x=analyzeSupportEfficiency(raw);assert.equal(x.gem.status,'ok');const ratio=x.gem.formulas.find(f=>f.label==='아크그리드 젬 버프 모형').value;const expected=Math.floor((ratio**4.24-1)*10000+1e-9)/100/1.4;assert(Math.abs(x.gem.efficiency-expected)<0.02,`${x.gem.efficiency} vs ${expected} (ratio rounded to 4 decimals)`);assert.equal(x.gem.formulas.find(f=>f.label==='젬 효율 (%)').value,x.gem.efficiency);assert(x.gem.efficiency>Math.floor((ratio-1)*10000)/100);assert(x.gem.assumptions.some(a=>a.includes('1.4로 나눕니다')))});

// 영웅·전설 cores (2026-09-18): accepted within their in-game caps and read from the 유물 column.
const legendGem=tip([['젬 기본 정보','젬 타입 : 질서<br>젬 포인트 : 3'],['젬 효과','필요 의지력 : 4<br>질서 포인트 : <font>3</font><br>[공격력] Lv.1']]);
const ponyCores=grade=>[['질서의 해 코어 : 아리아 엑센트',[{Index:0,IsActive:true,Grade:'전설',Tooltip:legendGem}]],['질서의 달 코어 : 아리아 펄스',null],['질서의 별 코어 : 풍요의 바람',[]],
  ['혼돈의 해 코어 : 신념의 강화',[{Index:0,IsActive:true,Grade:'전설',Tooltip:legendGem},{Index:1,IsActive:true,Grade:'전설',Tooltip:legendGem}]],['혼돈의 달 코어 : 치명적인 흔적',null],['혼돈의 별 코어 : 구원',[]],
].map(([Name,Gems],Index)=>({Index,Name,Grade:grade,Point:0,Gems}));
const ponyEffects=[{Name:'낙인력',Level:3,Tooltip:'낙인력 +0.30%'},{Name:'아군 피해 강화',Level:6,Tooltip:'아군 피해량 강화 효과 +0.36%'},{Name:'공격력',Level:5,Tooltip:'공격력 +0.20%'},{Name:'추가 피해',Level:4,Tooltip:'추가 피해 +0.16%'}];
const LOW_GRADE_LINE='영웅·전설 코어는 같은 포인트의 유물 기준표(10·14P는 유물·고대 동일)를 사용합니다.';

test('legendary zero-point cores with legendary gems calculate like the same relic cores',()=>{
  const legend=fixture('최대 생명력 +14000');legend.ArkGrid={Slots:ponyCores('전설'),Effects:ponyEffects};
  const relic=structuredClone(legend);for(const core of relic.ArkGrid.Slots)core.Grade='유물';
  const score=support.evaluateNativeSupportScore(legend),relicScore=support.evaluateNativeSupportScore(relic);
  assert.deepEqual(score.missing,[]);assert(score.value>0);assert.equal(score.factors.orderCore,1);assert.equal(score.value,relicScore.value);
  assert(score.assumptions.includes(LOW_GRADE_LINE));assert(!relicScore.assumptions.includes(LOW_GRADE_LINE));
  const x=analyzeSupportEfficiency(legend),y=analyzeSupportEfficiency(relic);
  assert.equal(x.bracelet.status,'ok');assert.equal(x.gem.status,'ok');assert(x.bracelet.efficiency>0);assert(x.gem.efficiency>0);
  assert.equal(x.bracelet.efficiency,y.bracelet.efficiency);assert.equal(x.gem.efficiency,y.gem.efficiency);assert.equal(x.gem.optionEfficiency,y.gem.optionEfficiency);
  assert.deepEqual(x.gem.pointBreakdown,[]);assert(x.bracelet.assumptions.includes(LOW_GRADE_LINE));assert(x.gem.assumptions.includes(LOW_GRADE_LINE));assert(!y.gem.assumptions.includes(LOW_GRADE_LINE));
});

test('legendary and heroic cores at their caps use the relic table rows',()=>{
  const score=slots=>{const raw=fixture('최대 생명력 +14000');raw.ArkGrid.Slots=slots;const result=support.evaluateNativeSupportScore(raw);assert.deepEqual(result.missing,[]);return result};
  assert.equal(score([supportOrderCore(0,14,'전설'),supportOrderCore(1,14,'전설')]).factors.orderCore,1.012*1.012);
  assert.equal(score([supportOrderCore(0,14,'전설'),supportOrderCore(1,14,'전설')]).factors.orderCore,score([supportOrderCore(0,14,'유물'),supportOrderCore(1,14,'유물')]).factors.orderCore);
  assert.equal(score([supportOrderCore(2,14,'전설')]).factors.orderCore,1.006);
  assert.equal(score([supportOrderCore(0,10,'영웅'),supportOrderCore(1,10,'영웅'),supportOrderCore(2,10,'영웅')]).factors.orderCore,1.012*1.012*1);
  const chaos=(grade,point)=>[{Index:3,Name:'혼돈의 해 코어 : 신념의 강화',Grade:grade,Point:point,Gems:[]},{Index:4,Name:'혼돈의 달 코어 : 치명적인 흔적',Grade:grade,Point:point,Gems:[]}];
  const legend14=score(chaos('전설',14)),relic14=score(chaos('유물',14)),ancient14=score(chaos('고대',14)),hero10=score(chaos('영웅',10)),relic10=score(chaos('유물',10));
  assert.equal(legend14.value,relic14.value);assert.equal(relic14.value,ancient14.value);assert.equal(hero10.value,relic10.value);
  assert.notEqual(legend14.value,score([]).value);assert.notEqual(legend14.value,hero10.value);
});

test('core points above the heroic or legendary cap and unknown grades never become a score',()=>{
  for(const slots of [[supportOrderCore(0,15,'전설')],[supportOrderCore(0,11,'영웅')],[supportOrderCore(0,10,'희귀')],[{...supportOrderCore(0,10),Grade:'전설',Point:20}],
    [{Index:3,Name:'혼돈의 해 코어 : 신념의 강화',Grade:'전설',Point:17,Gems:[]}],[{Index:3,Name:'혼돈의 해 코어 : 신념의 강화',Grade:'영웅',Point:14,Gems:[]}]]){
    const raw=fixture('최대 생명력 +14000');raw.ArkGrid.Slots=slots;
    const result=support.evaluateNativeSupportScore(raw);assert.equal(result.value,null);assert.equal(result.factors,null);assert.deepEqual(result.missing,['아크그리드 코어']);
    const x=analyzeSupportEfficiency(raw);assert.equal(x.bracelet.status,'unavailable');assert.equal(x.gem.status,'unavailable');
  }
});

test('10P and 14P rows of every support core table are identical for relic and ancient grades',async()=>{
  const {default:facts}=await import('../src/data/gem-model-facts.json',{with:{type:'json'}});
  const names=Object.keys(facts.coreFinal);assert.equal(names.length,18);
  for(const name of names)for(const point of [10,14]){assert(facts.coreFinal[name][point]?.유물,`${name} ${point}`);assert.deepEqual(facts.coreFinal[name][point].유물,facts.coreFinal[name][point].고대,`${name} ${point}`)}
  for(const point of [10,14])for(const slots of [[0,1,2],[0],[2]]){
    const order=grade=>{const raw=fixture('최대 생명력 +14000');raw.ArkGrid.Slots=slots.map(i=>supportOrderCore(i,point,grade));return support.evaluateNativeSupportScore(raw).factors.orderCore};
    assert.equal(order('유물'),order('고대'));assert.equal(order('전설'),order('유물'));
  }
});

// Official input forms accepted on 2026-09-18 (roster scan of 221 characters).
test('cores without gem effects arrive as an official Effects:null and score like an empty effect list',()=>{
  const raw=fixture('최대 생명력 +14000');raw.ArkGrid={Slots:[supportOrderCore(0,20),supportOrderCore(1,20)],Effects:[]};
  const expected=support.evaluateNativeSupportScore(raw),efficiency=analyzeSupportEfficiency(raw);assert.deepEqual(expected.missing,[]);assert.equal(expected.factors.orderCore,1.0942**2);
  raw.ArkGrid.Effects=null;const before=structuredClone(raw);
  assert.deepEqual(support.evaluateNativeSupportScore(raw),expected);assert.deepEqual(analyzeSupportEfficiency(raw),efficiency);assert.deepEqual(raw,before);
  assert.equal(efficiency.gem.status,'ok');assert.equal(efficiency.gem.optionEfficiency,0);
});
test('sun, moon and star order cores are recognised by name in any slot and a repeated kind fails',()=>{
  const ordered=fixture('최대 생명력 +14000');ordered.ArkGrid.Slots=[supportOrderCore(0,18),supportOrderCore(1,17),supportOrderCore(2,17)];
  const expected=support.evaluateNativeSupportScore(ordered);assert.deepEqual(expected.missing,[]);
  const swapped=fixture('최대 생명력 +14000');swapped.ArkGrid.Slots=[{...supportOrderCore(1,17),Index:0},{...supportOrderCore(0,18),Index:1},{...supportOrderCore(2,17),Index:2}];
  assert.equal(support.evaluateNativeSupportScore(swapped).factors.orderCore,expected.factors.orderCore);assert.equal(support.evaluateNativeSupportScore(swapped).value,expected.value);
  const scattered=fixture('최대 생명력 +14000');scattered.ArkGrid.Slots=[{...supportOrderCore(2,17),Index:0},{Index:1,Name:'혼돈의 해 코어 : 신념의 강화',Grade:'고대',Point:17,Gems:[]},{...supportOrderCore(1,17),Index:2},{...supportOrderCore(0,18),Index:5}];
  const result=support.evaluateNativeSupportScore(scattered);assert.deepEqual(result.missing,[]);assert.equal(result.factors.orderCore,expected.factors.orderCore);
  const lone=fixture('최대 생명력 +14000');lone.ArkGrid.Slots=[{...supportOrderCore(0,20),Index:4}];assert.equal(support.evaluateNativeSupportScore(lone).factors.orderCore,1.012);
  const twoSuns=fixture('최대 생명력 +14000');twoSuns.ArkGrid.Slots=[{...supportOrderCore(0,17),Index:2},{...supportOrderCore(0,17),Index:3,Name:'질서의 해 코어 : 햇살의 품'}];
  const failed=support.evaluateNativeSupportScore(twoSuns);assert.equal(failed.value,null);assert.deepEqual(failed.missing,['지원 질서 코어 중복']);
});
test('an unopened evolution karma description is rank zero while other wording still fails',()=>{
  const raw=fixture('최대 생명력 +14000'),ranked=support.evaluateNativeSupportScore(raw);
  raw.ArkPassive.Points[1].Description='';const empty=support.evaluateNativeSupportScore(raw);assert.deepEqual(empty.missing,[]);assert(empty.value>0);assert(empty.value<ranked.value);
  raw.ArkPassive.Points[1].Description='미개방';assert.equal(support.evaluateNativeSupportScore(raw).value,empty.value);
  raw.ArkPassive.Points[1].Description='0랭크 0레벨';assert.equal(support.evaluateNativeSupportScore(raw).value,empty.value);
  for(const description of ['abc','미개방 상태',null]){raw.ArkPassive.Points[1].Description=description;const result=support.evaluateNativeSupportScore(raw);assert.equal(result.value,null);assert.deepEqual(result.missing,['진화 카르마']);}
});
test('an absent or null avatar block is a known zero percent for the support score',()=>{
  const raw=fixture('최대 생명력 +14000'),expected=support.evaluateNativeSupportScore(raw),efficiency=analyzeSupportEfficiency(raw);assert.deepEqual(raw.ArmoryAvatars,[]);
  raw.ArmoryAvatars=null;assert.deepEqual(support.evaluateNativeSupportScore(raw),expected);assert.deepEqual(analyzeSupportEfficiency(raw),efficiency);
  delete raw.ArmoryAvatars;assert.deepEqual(support.evaluateNativeSupportScore(raw),expected);assert.equal(analyzeSupportEfficiency(raw).bracelet.status,'ok');
  raw.ArmoryAvatars={};assert.equal(support.evaluateNativeSupportScore(raw).value,null);assert.equal(analyzeSupportEfficiency(raw).bracelet.status,'unavailable');
});
test('the ability stone reduction line does not disturb the support engraving reading',()=>{
  const raw=fixture('최대 생명력 +14000'),expected=support.evaluateNativeSupportScore(raw);
  raw.ArmoryEngraving.ArkPassiveEffects.push({Name:'방어력 감소',Grade:'',Level:0,AbilityStoneLevel:-1});
  assert.deepEqual(support.evaluateNativeSupportScore(raw),expected);assert.equal(analyzeSupportEfficiency(raw).bracelet.status,'ok');
  raw.ArmoryEngraving.ArkPassiveEffects.push({Name:'각성',Grade:'',Level:0,AbilityStoneLevel:-1});
  assert.deepEqual(support.evaluateNativeSupportScore(raw),expected);
  raw.ArmoryEngraving.ArkPassiveEffects.pop();raw.ArmoryEngraving.ArkPassiveEffects.push({Name:'각성',Grade:'',Level:0,AbilityStoneLevel:2});
  assert.equal(support.evaluateNativeSupportScore(raw).value,null);
});

// Input forms accepted on 2026-09-18, second pass.
test('neutral bracelet lines on a supporter carry no coefficient and may repeat while unknown lines still fail',()=>{
  const sep="<br><img src='emoticon_tooltip_bracelet_changeable'></img>";
  const expected=support.evaluateNativeSupportScore(fixture('최대 생명력 +14000'));assert(expected.value>0);
  const raw=fixture(['최대 생명력 +14000','효과 부여 가능','효과 부여 가능','마법 방어력 +1200'].join(sep));
  const result=support.evaluateNativeSupportScore(raw);assert.equal(result.value,expected.value);
  assert(result.assumptions.includes("팔찌 옵션 '효과 부여 가능', '효과 부여 가능', '마법 방어력 +1200'은 환산 모형에 영향이 없어 기여 없음으로 계산했습니다."));
  assert(!expected.assumptions.some(x=>x.startsWith('팔찌 옵션 ')));
  assert.equal(analyzeSupportEfficiency(raw).bracelet.efficiency,analyzeSupportEfficiency(fixture('최대 생명력 +14000')).bracelet.efficiency);
  for(const text of ['[긴급수혈] 생명력이 50% 이하일 경우 몬스터에게 피격 시 30% 확률로 생명력을 16000 회복한다. (재사용 대기시간 120초)','[강타] 치명타 적중 후 4초 동안 제압이 65, 숙련이 65 증가한다.']){
    assert.equal(support.evaluateNativeSupportScore(fixture(text)).value,expected.value,text);
  }
  assert.equal(support.evaluateNativeSupportScore(fixture('[정체불명] 새 효과')).value,null);
});
test('a missing or null engraving block is no engraving for the support score while a block without an array still fails',()=>{
  const raw=fixture('최대 생명력 +14000');raw.ArmoryEngraving={ArkPassiveEffects:[]};const expected=support.evaluateNativeSupportScore(raw);assert(expected.value>0);
  raw.ArmoryEngraving=null;assert.deepEqual(support.evaluateNativeSupportScore(raw),expected);assert.equal(analyzeSupportEfficiency(raw).bracelet.status,'ok');
  delete raw.ArmoryEngraving;assert.deepEqual(support.evaluateNativeSupportScore(raw),expected);assert.equal(analyzeSupportEfficiency(raw).bracelet.status,'ok');
  for(const block of [{},{ArkPassiveEffects:null}]){raw.ArmoryEngraving=block;assert.equal(support.evaluateNativeSupportScore(raw).value,null,JSON.stringify(block));assert.equal(analyzeSupportEfficiency(raw).bracelet.status,'unavailable')}
});
test('a dealer core on a supporter is a known core without a buff effect while an unknown name still fails',()=>{
  const raw=fixture('최대 생명력 +14000');const expected=support.evaluateNativeSupportScore(raw);assert(expected.value>0);
  raw.ArkGrid={Slots:[{Index:0,Name:'질서의 달 코어 : 심판의 시간',Grade:'영웅',Point:0,Gems:[]}],Effects:[]};
  const result=support.evaluateNativeSupportScore(raw);assert.equal(result.value,expected.value);
  assert(result.assumptions.includes("'질서의 달 코어 : 심판의 시간'는 서포터 버프 표에 없는 코어라 기여 없음으로 계산했습니다."));
  assert(!expected.assumptions.some(x=>x.includes('서포터 버프 표에 없는 코어')));
  assert.equal(analyzeSupportEfficiency(raw).bracelet.status,'ok');
  raw.ArkGrid.Slots[0].Point=11;assert.equal(support.evaluateNativeSupportScore(raw).value,null);
  raw.ArkGrid.Slots[0].Point=0;raw.ArkGrid.Slots[0].Name='질서의 달 코어 : 아직 없는 코어';assert.equal(support.evaluateNativeSupportScore(raw).value,null);
});
