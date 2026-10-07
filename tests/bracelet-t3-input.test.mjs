import test from 'node:test';
import assert from 'node:assert/strict';
import {BRACELET_T3_DATA as DATA,BRACELET_T3_EFFECTS as EFFECTS} from '../src/bracelet-t3-data.js';
import {readBraceletT3Input} from '../src/bracelet-t3-input.js';
const low='#00B5FF',middle='#CE43FC';
const precise=`[<FONT COLOR='${middle}'>정밀</FONT>] 몬스터에게 공격 적중 시 치명타 적중이 4% 증가한다. (60레벨 초과 몬스터에게는 효과 감소)`;
const reversal=`[<FONT COLOR='${low}'>반전</FONT>] 생명력이 15% 이하일 경우 몬스터에게 피격 시 10초 후 체력 반전이 일어난다. (재사용 대기 시간 900초) (60레벨 초과 몬스터에게는 효과 감소)`;
const cycle=`[<FONT COLOR='${low}'>순환</FONT>] 몬스터에게 공격 적중 시 30초 동안 '순환' 효과를 획득한다. 해당 효과는 갱신되지 않는다.<BR>순환 : 10초 간격으로 스킬 피해 3% 증가, 치명타 적중률 5% 증가, 치명타 피해 8% 증가 효과가 순차적으로 적용된다. (60레벨 초과 몬스터에게는 효과 감소)`;
const superiority=`[<FONT COLOR='${low}'>우월</FONT>] 몬스터에게 공격 적중 시 주는 피해가 2% 증가한다. (60레벨 초과 몬스터에게는 효과 감소)`;
function item(fixed,granted,Grade='고대',tier=3){return {Type:'팔찌',Grade,Tooltip:JSON.stringify({a:{type:'ItemTitle',value:{leftStr2:`아이템 티어 ${tier}`}},b:{type:'ItemPartBox',value:{Element_000:'팔찌 효과',Element_001:[...fixed.map(t=>`<img src='emoticon_tooltip_bracelet_locked'></img>${t}`),...granted.map(t=>`<img src='emoticon_tooltip_bracelet_changeable'></img>${t}`)].join('<BR>')}}})};}
test('T3 table preserves every family, rounded weight, old stat range and zero ticket policy',()=>{
 assert.equal(EFFECTS.length,48);const special=EFFECTS.filter(r=>r.category==='special');assert.equal(special.length,40);
 assert.equal(new Set(EFFECTS.map(r=>r.id)).size,48);assert.equal(special.filter(r=>r.fixedAllowed).length,20);
 assert.deepEqual(special.find(r=>r.label==='반전').tierWeights,[2.1,1.05,.35]);
 assert.deepEqual(special.find(r=>r.label==='순환').tierWeights,[.6667,.3333,.1111]);
 assert.deepEqual(special.find(r=>r.label==='정밀').tierWeights,[1.0909,.5455,.1818]);
 assert.ok(Math.abs(special.flatMap(r=>r.tierWeights).reduce((a,b)=>a+b,0)-100.0001)<1e-10);
 assert.deepEqual(EFFECTS.find(r=>r.id==='base.vitality').ranges.relic[0],{min:500,max:750,weight:10});
 assert.equal(EFFECTS.find(r=>r.id==='base.mainStat').ranges.ancient.at(-1).max,5000);
 assert.equal(DATA.normalRolls,4);assert.equal(DATA.maxReconversionTickets,0);assert.equal(DATA.categoryLimits.special,5);
 assert.ok(Object.isFrozen(EFFECTS[0].ranges.relic[0]));
});
test('observed ancient precision/reversal complete rows map to low/middle tiers and retain three granted slots',()=>{
 const input=item(['특화 +111'],['치명 +79',precise,reversal]),before=JSON.stringify(input),r=readBraceletT3Input(input);
 assert.equal(r.status,'ok');assert.equal(r.itemTier,3);assert.equal(r.input.itemTier,3);assert.equal(r.input.reconversionTickets,0);
 assert.deepEqual(r.input.fixed,[{id:'combat.specialization',value:111}]);
 assert.deepEqual(r.input.granted,[{id:'combat.crit',value:79},{id:'special.t3Precision',tier:2},{id:'special.t3Reversal',tier:1}]);
 assert.equal(r.target[2].labelColor,middle);assert.equal(r.target[3].labelColor,low);assert.equal(Object.hasOwn(r.target[0],'labelColor'),false);
 assert.equal(JSON.stringify(input),before);
});
test('multiline cycle is one option; relic vitality is checked against the T3 range',()=>{
 const a=readBraceletT3Input(item(['특화 +95'],[cycle,'치명 +65',superiority]));assert.equal(a.status,'ok');
 assert.deepEqual(a.input.granted,[{id:'special.t3Cycle',tier:1},{id:'combat.crit',value:65},{id:'special.t3Superiority',tier:1}]);
 const b=readBraceletT3Input(item(['체력 +2,075','특화 +77'],['신속 +54'],'유물'));assert.equal(b.status,'ok');assert.equal(b.input.fixed[0].value,2075);
 assert.equal(readBraceletT3Input(item(['체력 +5000','특화 +77'],['신속 +54'],'유물')).status,'unavailable');
});
test('whole effect text and title color must both match verified T3 rows',()=>{
 for(const changed of [precise.replace('4%','5%'),precise.replace(middle,low),precise+' 조건부 발동',precise.replace('60레벨','70레벨'),precise.replace('증가한다','감소한다'),precise.replace(/<FONT.*?>정밀<\/FONT>/,'정밀')]){
  const r=readBraceletT3Input(item(['특화 +111'],['치명 +79',changed,reversal]));assert.equal(r.status,'unavailable');
 }
 // An unobserved family has a probability weight but no fabricated tooltip parser.
 assert.equal(readBraceletT3Input(item(['특화 +111'],['치명 +79',precise.replaceAll('정밀','습격'),reversal])).status,'unavailable');
});
test('invalid tier, rarity, duplicated families, slot count and malformed stat are refused',()=>{
 const good=()=>item(['체력 +2075','특화 +77'],['신속 +54'],'유물');
 for(const v of [null,{},item(['특화 +111'],['치명 +79',precise,reversal],'고대',4),item(['특화 +111'],['치명 +79',precise,reversal],'유물'),item(['특화 +111'],['특화 +79',precise,reversal]),item(['특화 +111'],['치명 +79','신속 +80',reversal]),item(['체력 +2,,075','특화 +77'],['신속 +54'],'유물'),item(['특화 +111',precise],['치명 +79',reversal])])assert.equal(readBraceletT3Input(v).status,'unavailable');
 const a=good(),tooltip=JSON.parse(a.Tooltip);tooltip.c=tooltip.a;a.Tooltip=JSON.stringify(tooltip);assert.equal(readBraceletT3Input(a).status,'unavailable');
});
