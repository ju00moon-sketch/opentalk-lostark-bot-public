import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRosterValuationTargets } from '../src/roster-valuation-targets.js';

const observedAt=1790000000000;
const tooltip=(name,{tier=4,quality=85,trade='|거래가능',parts=[],extra=[]}={})=>JSON.stringify({
  Name:{type:'NameTagBox',value:name},Title:{type:'ItemTitle',value:{leftStr2:`아이템 레벨 1700 (티어 ${tier})`,qualityValue:quality}},
  Trade:{type:'MultiTextBox',value:trade},...Object.fromEntries(parts.map(([title,text],i)=>[`Part${i}`,{type:'ItemPartBox',value:{Element_000:title,Element_001:text}}])),
  ...Object.fromEntries(extra.map((text,i)=>[`Text${i}`,{type:'SingleTextBox',value:text}]))});
const gem=(slot=0,name='10레벨 겁화의 보석',level=10,trade='|거래가능')=>({Slot:slot,Name:name,Level:level,Grade:'고대',Tooltip:tooltip(name,{trade})});
const raw=()=>({ArmoryProfile:{CharacterName:'검토바드',ServerName:'루페온'},ArmoryGem:{Gems:[]},ArmoryEquipment:[],ArmoryEngraving:{ArkPassiveEffects:[]}});
const parse=value=>parseRosterValuationTargets(value,{observedAt});

test('requires an official profile identity and distinguishes missing from observed empty sections',()=>{
  assert.equal(parse({}).status,'unavailable');
  const empty=parse(raw());assert.equal(empty.characterName,'검토바드');assert.equal(empty.observedAt,observedAt);
  for(const part of Object.values(empty.components))assert.equal(part.status,'empty');
  const missing=raw();delete missing.ArmoryGem;delete missing.ArmoryEngraving;delete missing.ArmoryEquipment;
  for(const part of Object.values(parse(missing).components))assert.equal(part.status,'unavailable');
});
test('ordinary gem quotes share price by tier type and level but preserve physical slots',()=>{
  const input=raw();input.ArmoryGem.Gems=[gem(0),gem(1)];const result=parse(input),items=result.components.gems.items;
  assert.equal(items.length,2);assert.notEqual(items[0].id,items[1].id);assert.equal(items[0].quoteKey,items[1].quoteKey);
  const quote=result.quotes.find(row=>row.quoteKey===items[0].quoteKey);
  assert.equal(quote.kind,'auction');assert.equal(quote.body.CategoryCode,210000);assert.equal(quote.body.ItemTier,4);assert.equal(quote.body.ItemGrade,'고대');
  assert.equal(quote.body.ItemName,'10레벨 겁화의 보석');assert.deepEqual(quote.body.SkillOptions,[]);
  assert.deepEqual(input.ArmoryGem.Gems,[gem(0),gem(1)],'raw input is unchanged');
});
test('explicit bound ordinary gems are known zero without price requests',()=>{
  const input=raw();input.ArmoryGem.Gems=[gem(0,'7레벨 광휘의 보석 (귀속)',7,'|거래 불가')];
  const result=parse(input),item=result.components.gems.items[0];
  assert.equal(item.status,'ok');assert.equal(item.bound,true);assert.equal(item.zeroReason,'bound_gem');assert.equal(result.quotes.length,0);
});
test('a tuned gem is priced from the two gems it can be restored into, and only a labelled one stays zero',()=>{
  const input=raw();input.ArmoryGem.Gems=[gem(0,'8레벨 광휘의 보석',8,'|거래 불가')];
  const result=parse(input),item=result.components.gems.items[0];
  assert.equal(item.status,'ok');assert.equal(item.bound,true);assert.equal(item.zeroReason,undefined);assert.equal(item.quoteKey,undefined);
  assert.equal(item.substituteBasis,'tuned_gem_restore');assert.equal(item.substituteQuoteKeys.length,2);
  assert.deepEqual(result.quotes.map(row=>row.body.ItemName),['8레벨 겁화의 보석','8레벨 작열의 보석']);
  assert.deepEqual(result.quotes.map(row=>row.quoteKey),item.substituteQuoteKeys);
  for(const row of result.quotes){assert.equal(row.body.CategoryCode,210000);assert.equal(row.body.ItemTier,4);assert.equal(row.body.ItemGrade,'고대');}
  // 이름에 (귀속)이 붙은 이벤트 보석만 값이 0이고 시세를 묻지 않는다.
  const labelled=raw();labelled.ArmoryGem.Gems=[gem(0,'8레벨 광휘의 보석 (귀속)',8,'|거래 불가')];
  const zero=parse(labelled);assert.equal(zero.components.gems.items[0].zeroReason,'bound_gem');assert.equal(zero.quotes.length,0);
});
test('ambiguous gem identity, duplicate slots, binding conflicts and absent labels are never priced or zeroed',()=>{
  for(const mutate of [r=>r.ArmoryGem.Gems.push(gem(0)),r=>r.ArmoryGem.Gems[0].Level=9,
    r=>r.ArmoryGem.Gems[0].Tooltip='{}',r=>r.ArmoryGem.Gems[0].Tooltip=tooltip('10레벨 겁화의 보석 (귀속)')]){
    const input=raw();input.ArmoryGem.Gems=[gem()];mutate(input);const result=parse(input);
    assert.notEqual(result.components.gems.status,'ok');assert.equal(result.quotes.length,0);
  }
});
test('accessories match exact major effects and at least observed quality while retaining common-effect observations',()=>{
  const input=raw();input.ArmoryEquipment=[{Type:'목걸이',Name:'도래한 결전의 목걸이',Grade:'고대',Tooltip:tooltip('도래한 결전의 목걸이',{
    parts:[['연마 효과','적에게 주는 피해 +2.00%<BR>추가 피해 +0.70%<BR>공격력 +390']]})}];
  const result=parse(input),item=result.components.accessories.items[0],quote=result.quotes[0];
  assert.equal(item.status,'ok');assert.equal(item.quality,85);assert.equal(quote.body.ItemGradeQuality,85);
  assert.deepEqual(quote.body.EtcOptions,[{FirstOption:7,SecondOption:41,MinValue:70,MaxValue:70},{FirstOption:7,SecondOption:42,MinValue:200,MaxValue:200}]);
  assert.equal(item.options.length,3);assert.equal(item.matchBasis,'major_options_exact_quality_at_least');
});
test('unknown or duplicated accessory options and duplicate unique slots fail closed',()=>{
  for(const text of ['미확인 주요 효과 +2.00%','추가 피해 +0.70%<BR>추가 피해 +0.70%']){
    const input=raw();input.ArmoryEquipment=[{Type:'목걸이',Name:'목걸이',Grade:'고대',Tooltip:tooltip('목걸이',{parts:[['연마 효과',text]]})}];
    assert.equal(parse(input).components.accessories.items[0].status,'unavailable');assert.equal(parse(input).quotes.length,0);
  }
});
test('engraving targets expose only equipped observations and ignore stone levels in book identity',()=>{
  const input=raw();input.ArmoryEngraving.ArkPassiveEffects=[{Name:'원한',Grade:'유물',Level:4,AbilityStoneLevel:3}];
  const result=parse(input),item=result.components.engravings.items[0];
  assert.equal(item.coverage,'equipped_only');assert.equal(item.accountKey,'engraving:루페온:원한');assert.equal(item.level,4);
  assert(item.bookQuotes.some(q=>q.grade==='유물'));assert(result.quotes.some(q=>q.kind==='market'&&q.category===40000&&q.name==='원한 각인서'&&q.grade==='유물'));
  input.ArmoryEngraving.ArkPassiveEffects[0].AbilityStoneLevel=0;
  assert.equal(parse(input).components.engravings.items[0].targetKey,item.targetKey);
});
test('honing observes actual ordinary levels and never invents advanced levels or materials',()=>{
  const input=raw();input.ArmoryEquipment=[{Type:'무기',Name:'+21 운명의 전율 총',Grade:'고대',Tooltip:tooltip('+21 운명의 전율 총')}];
  const first=parse(input).components.honing.items[0];assert.equal(first.refinement,21);assert.equal(first.advancedRefinement,null);assert.equal(first.itemLevel,1700);
  input.ArmoryEquipment[0].Tooltip=tooltip('+21 운명의 전율 총',{extra:['[상급 재련] 20단계']});
  assert.equal(parse(input).components.honing.items[0].advancedRefinement,20);
});
test('advanced refinement reads the stage line and ignores the milestone lines the official tooltip appends from stage 30',()=>{
  const honing=extra=>{const input=raw();input.ArmoryEquipment=[{Type:'무기',Name:'+21 운명의 전율 총',Grade:'고대',
    Tooltip:tooltip('+21 운명의 전율 총',{extra})}];return parse(input).components.honing.items[0];};
  const milestone='30단계 - 기본 효과 +2%';
  assert.equal(honing([`[상급 재련] 37단계\n${milestone}`]).advancedRefinement,37);
  assert.equal(honing([`[상급 재련] 40단계\n${milestone}\n40단계 - 기본 효과 +4%`]).advancedRefinement,40);
  assert.equal(honing(['[상급 재련] 30단계']).advancedRefinement,30);
  const unobserved=honing([milestone]);
  assert.equal(unobserved.status,'ok');assert.equal(unobserved.advancedRefinement,null);
  assert.equal(unobserved.advancedRefinementStatus,'unobserved');
  const ambiguous=honing(['[상급 재련] 30단계','[상급 재련] 31단계']);
  assert.equal(ambiguous.status,'unavailable');assert.equal(ambiguous.reason,'ambiguous_advanced_honing');
  assert.equal(honing(['[상급 재련] 41단계']).reason,'ambiguous_advanced_honing');
});
test('a character with no ordinary gem (Gems null, no effects) is an observed empty section; any other null stays unavailable',()=>{
  const none=raw();none.ArmoryGem={Gems:null,Effects:{Description:'',Skills:[]}};
  assert.equal(parse(none).components.gems.status,'empty');assert.equal(parse(none).components.gems.items.length,0);
  const skills=raw();skills.ArmoryGem={Gems:null,Effects:{Description:'',Skills:[{GemSlot:0,Name:'x',Description:['피해 8.00% 증가']}]}};
  assert.equal(parse(skills).components.gems.status,'unavailable');assert.equal(parse(skills).components.gems.reason,'invalid_gem_section');
  const bare=raw();bare.ArmoryGem={Gems:null};
  assert.equal(parse(bare).components.gems.status,'unavailable');
});
test('a vambrace without a honing prefix is stage zero while a bare weapon name stays unobserved',()=>{
  const input=raw();input.ArmoryEquipment=[{Type:'완갑',Name:'운명의 전율 완갑',Grade:'영웅',Tooltip:tooltip('운명의 전율 완갑')}];
  const vambrace=parse(input).components.honing.items[0];
  assert.equal(vambrace.status,'ok');assert.equal(vambrace.refinement,0);assert.equal(vambrace.itemName,'운명의 전율 완갑');assert.equal(vambrace.slot,'완갑');
  input.ArmoryEquipment=[{Type:'무기',Name:'운명의 전율 총',Grade:'고대',Tooltip:tooltip('운명의 전율 총')}];
  const weapon=parse(input).components.honing.items[0];
  assert.equal(weapon.status,'unavailable');assert.equal(weapon.reason,'honing_level_unobserved');
});
test('the ability stone reduction line is skipped and the remaining books are read; a graded reduction name is still a book',()=>{
  const input=raw();input.ArmoryEngraving.ArkPassiveEffects=[{Name:'원한',Grade:'유물',Level:4,AbilityStoneLevel:null},{Name:'질량 증가',Grade:'유물',Level:4,AbilityStoneLevel:3},{Name:'방어력 감소',Grade:'',Level:0,AbilityStoneLevel:-1}];
  const books=parse(input).components.engravings;
  assert.equal(books.status,'ok');assert.deepEqual(books.items.map(x=>x.name),['원한','질량 증가']);
  input.ArmoryEngraving.ArkPassiveEffects=[{Name:'방어력 감소',Grade:'',Level:0,AbilityStoneLevel:-1}];
  assert.equal(parse(input).components.engravings.status,'empty');
  input.ArmoryEngraving.ArkPassiveEffects=[{Name:'피해 감소',Grade:'유물',Level:2,AbilityStoneLevel:null}];
  const graded=parse(input).components.engravings;
  assert.equal(graded.status,'ok');assert.equal(graded.items[0].name,'피해 감소');
});
test('current engraving recipes use legendary and relic books only at five books per completed level',()=>{
  const input=raw();input.ArmoryEngraving.ArkPassiveEffects=[{Name:'원한',Grade:'유물',Level:2}];
  const result=parse(input),item=result.components.engravings.items[0];
  assert.deepEqual(item.bookQuotes.map(x=>[x.grade,x.quantity]),[['전설',20],['유물',10]]);
  assert.equal(result.quotes.length,2);assert.equal(item.progressCoverage,'completed_levels_only');
  input.ArmoryEngraving.ArkPassiveEffects[0]={Name:'원한',Grade:'전설',Level:3};
  assert.deepEqual(parse(input).components.engravings.items[0].bookQuotes.map(x=>[x.grade,x.quantity]),[['전설',15]]);
});
test('malformed excessive and hostile values yield fixed failures without throwing or echoing source markup',()=>{
  for(const input of [null,[],{ArmoryProfile:{CharacterName:'<script>'}},Object.defineProperty({},'ArmoryProfile',{get(){throw Error('private');}})])
    assert.equal(parse(input).status,'unavailable');
  const input=raw();input.ArmoryGem.Gems=[{...gem(),Tooltip:'x'.repeat(131073)}];const result=parse(input);
  assert.equal(result.components.gems.items[0].status,'unavailable');assert(!JSON.stringify(result).includes('xxxx'));
});
test('duplicate JSON keys, contradictory binding and malformed numeric grouping are unavailable',()=>{
  for(const modify of [g=>g.Tooltip=g.Tooltip.replace('"Trade":','"Trade":{"type":"MultiTextBox","value":"|거래 불가"},"Trade":'),
    g=>{g.Name='10레벨 겁화의 보석 (귀속)';g.Tooltip=tooltip(g.Name);},
    g=>g.Tooltip=g.Tooltip.replace('1700','1,70'),g=>g.Grade=['고대']]){
    const input=raw();input.ArmoryGem.Gems=[gem()];modify(input.ArmoryGem.Gems[0]);
    assert.equal(parse(input).components.gems.items[0].status,'unavailable');assert.equal(parse(input).quotes.length,0);
  }
});
test('gauntlet is a separate seventh honing target when observed, with the actual level preserved',()=>{
  const input=raw();input.ArmoryEquipment=[{Type:'완갑',Name:'+9 운명의 전율 완갑',Grade:'영웅',Tooltip:tooltip('+9 운명의 전율 완갑')}];
  const tip=JSON.parse(input.ArmoryEquipment[0].Tooltip);tip.Title.value.leftStr2='아이템 티어 4';input.ArmoryEquipment[0].Tooltip=JSON.stringify(tip);
  const result=parse(input);assert.equal(result.components.honing.items.length,1);assert.equal(result.components.honing.items[0].slot,'완갑');
  assert.equal(result.components.honing.items[0].refinement,9);assert.equal(result.components.honing.items[0].itemLevel,null);
});
