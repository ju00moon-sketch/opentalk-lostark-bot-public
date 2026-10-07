import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateCharacterValuation, aggregateRosterValuations } from '../src/roster-valuation.js';

const now=1790000000000;
const components=()=>Object.fromEntries(['gems','accessories','engravings','honing'].map(id=>[id,{status:'empty',items:[]}]));
const targets=()=>({version:'roster-targets-v1',status:'ok',characterName:'검토바드',serverName:'루페온',observedAt:now,targetKey:'a'.repeat(64),components:components()});
const item=(id='gem:0')=>({id,status:'ok',targetKey:'b'.repeat(64),quoteKey:'gem-price'});
const quote=(unitGold=100)=>({status:'ok',unitGold,checkedAt:now});

test('known bound zero is complete while a missing price remains unknown and excluded from known subtotal',()=>{
  const input=targets();input.components.gems={status:'ok',items:[{...item(),bound:true,zeroReason:'bound_gem'},item('gem:1')]};
  const value=calculateCharacterValuation(input,{now});assert.equal(value.complete,false);assert.equal(value.totalGold,null);assert.equal(value.knownGold,0);
  assert.equal(value.counts.known,1);assert.equal(value.counts.unknown,1);
});
test('a tuned gem takes the cheaper restore listing and is marked as an estimate',()=>{
  const input=targets();
  input.components.gems={status:'ok',items:[{id:'gem:0',status:'ok',targetKey:'b'.repeat(64),
    substituteQuoteKeys:['gem-blaze','gem-burn'],substituteBasis:'tuned_gem_restore'}]};
  const priced=calculateCharacterValuation(input,{now,quotes:{'gem-blaze':quote(344000),'gem-burn':quote(340000)}});
  const row=priced.components.gems.items[0];
  assert.equal(row.status,'ok');assert.equal(row.knownGold,340000);assert.equal(row.basis,'tuned_gem_restore');
  assert.equal(row.estimated,true);assert.equal(priced.counts.estimated,1);assert.equal(priced.estimatedItems,1);
  // 한쪽 매물만 있으면 그 값을 쓰고, 둘 다 없으면 0으로 세지 않고 모르는 항목으로 남긴다.
  const single=calculateCharacterValuation(input,{now,quotes:{'gem-burn':quote(12345)}});
  assert.equal(single.components.gems.items[0].knownGold,12345);
  const none=calculateCharacterValuation(input,{now,quotes:{}});
  assert.equal(none.components.gems.items[0].status,'unavailable');assert.equal(none.components.gems.items[0].reason,'price_unavailable');
  assert.equal(none.knownGold,0);assert.equal(none.complete,false);
});
test('market replacement and expected acquisition contribute once to separate and combined totals',()=>{
  const input=targets();input.components.gems={status:'ok',items:[item(),item('gem:1')]};input.components.honing={status:'ok',items:[{id:'weapon',status:'ok',targetKey:'c'.repeat(64)}]};
  const result=calculateCharacterValuation(input,{now,quotes:{'gem-price':quote(123.25)},costs:{['c'.repeat(64)]:{status:'ok',targetKey:'c'.repeat(64),modelVersion:'verified-fixture',expectedAcquisitionGold:1000,checkedAt:now}},
    extraComponents:{bracelet:{status:'ok',items:[{id:'bracelet',status:'ok',targetKey:'d'.repeat(64),expectedAcquisitionGold:500,checkedAt:now,modelVersion:'fixture'}]},arkgridGems:{status:'empty',items:[]}}});
  assert.equal(result.complete,true);assert.equal(result.marketReplacementGold,246.5);assert.equal(result.expectedAcquisitionGold,1500);assert.equal(result.totalGold,1746.5);
});
test('recipes multiply verified material quantities with current unit prices and preserve fractions',()=>{
  const input=targets();input.components.honing={status:'ok',items:[{id:'weapon',status:'ok',targetKey:'c'.repeat(64)}]};
  const result=calculateCharacterValuation(input,{now,quotes:{stone:quote(2.5)},costs:{['c'.repeat(64)]:{status:'ok',targetKey:'c'.repeat(64),modelVersion:'fixture',requirements:[{quoteKey:'stone',quantity:2.2}],fixedGold:4,checkedAt:now}}});
  assert.equal(result.expectedAcquisitionGold,9.5);
});
test('unknown observations, unverified recipes, stale prices and mismatched target hashes cannot make a complete total',()=>{
  for(const quotes of [{},{'gem-price':quote(-1)},{'gem-price':quote(NaN)},{'gem-price':{...quote(),checkedAt:now-300001}}]){
    const input=targets();input.components.gems={status:'ok',items:[item()]};const value=calculateCharacterValuation(input,{now,quotes});assert.equal(value.totalGold,null);assert.equal(value.knownGold,0);
  }
  const input=targets();input.components.honing={status:'ok',items:[{id:'weapon',status:'ok',targetKey:'c'.repeat(64)}]};
  assert.equal(calculateCharacterValuation(input,{now,costs:{['c'.repeat(64)]:{status:'ok',targetKey:'x',modelVersion:'x',expectedAcquisitionGold:0,checkedAt:now}}}).totalGold,null);
  input.components.honing={status:'unavailable',items:[],reason:'missing_equipment'};
  assert.equal(calculateCharacterValuation(input,{now}).complete,false);
});
// A character wearing one engraving at the given stage, priced at 100 G per book with 5 books per stage.
function bookCharacter(name,level,{serverName='루페온',engraving='원한',grade='유물',priced=true,gems=[]}={}) {
  const key=String(level).repeat(64),input=targets();input.characterName=name;input.serverName=serverName;
  input.components.engravings={status:'ok',items:[{id:'engraving:0',status:'ok',targetKey:key,kind:'engraving',accountKey:`engraving:${serverName}:${engraving}`,grade,level}]};
  if(gems.length)input.components.gems={status:'ok',items:gems};
  return calculateCharacterValuation(input,{now,quotes:{book:quote(100),'gem-price':quote(1000)},
    costs:priced?{[key]:{status:'ok',targetKey:key,modelVersion:'fixture',requirements:[{quoteKey:'book',quantity:level*5}],fixedGold:0,checkedAt:now}}:{}});
}
test('excludingSharedBooks drops the engraving books while the full character total keeps them',()=>{
  const value=bookCharacter('검토바드',2,{gems:[item()]});
  assert.equal(value.totalGold,2000);assert.equal(value.components.engravings.totalGold,1000);
  assert.equal(value.excludingSharedBooks.totalGold,1000);assert.equal(value.excludingSharedBooks.marketReplacementGold,1000);
  assert.equal(value.excludingSharedBooks.complete,true);assert.deepEqual(value.excludingSharedBooks.counts,{items:1,known:1,unknown:0,estimated:0});
});
test('two characters on one server share one engraving book entry valued at the highest stage',()=>{
  const values=[bookCharacter('검토바드1',1),bookCharacter('검토바드2',2)];
  const roster=aggregateRosterValuations(values);assert.equal(roster.complete,true);
  assert.equal(roster.engravingBooks.length,1);assert.deepEqual(roster.engravingBooks[0],{serverName:'루페온',accountKey:'engraving:루페온:원한',name:'원한',grade:'유물',level:2,
    status:'ok',gold:1000,reason:null,characters:['검토바드2','검토바드1'],coverage:'maximum_observed_equipped_level'});
  assert.equal(roster.engravingBooksGold,1000);assert.equal(roster.engravingBooksComplete,true);assert.equal(roster.totalGold,1000);
  assert.equal(values[0].totalGold,500);assert.equal(values[1].totalGold,1000);assert.equal('sharedDeductionGold' in roster,false);
});
test('an engraving worn by a single character is listed once at the top and left out of the character sum',()=>{
  const value=bookCharacter('검토바드',3,{gems:[item()]});
  const roster=aggregateRosterValuations([value]);
  assert.equal(roster.engravingBooks.length,1);assert.deepEqual(roster.engravingBooks[0].characters,['검토바드']);assert.equal(roster.engravingBooksGold,1500);
  assert.equal(roster.knownMarketReplacementGold,2500);assert.equal(roster.totalGold,2500);assert.equal(value.excludingSharedBooks.totalGold,1000);
});
test('the same engraving on different servers is a separate entry per server and legend ranks below relic',()=>{
  const values=[bookCharacter('검토바드1',4),bookCharacter('검토바드2',4,{serverName:'카제로스'}),bookCharacter('검토바드3',4,{grade:'전설'})];
  const roster=aggregateRosterValuations(values);
  assert.deepEqual(roster.engravingBooks.map(book=>[book.serverName,book.grade,book.characters]),[['루페온','유물',['검토바드1','검토바드3']],['카제로스','유물',['검토바드2']]]);
  assert.equal(roster.engravingBooksGold,4000);assert.equal(roster.totalGold,4000);
});
test('an unpriced highest stage marks the entry, the book list and the roster incomplete without turning it into zero',()=>{
  const values=[bookCharacter('검토바드1',1),bookCharacter('검토바드2',2,{priced:false}),bookCharacter('검토바드3',1,{engraving:'예리한 둔기'})];
  const roster=aggregateRosterValuations(values);
  const missing=roster.engravingBooks.find(book=>book.name==='원한');
  assert.equal(missing.status,'unavailable');assert.equal(missing.gold,null);assert.equal(missing.reason,'book_price_unavailable');assert.equal(missing.level,2);
  assert.equal(roster.engravingBooks.at(-1),missing,'unavailable entries sort last');
  assert.equal(roster.engravingBooksComplete,false);assert.equal(roster.complete,false);assert.equal(roster.totalGold,null);
  assert.equal(roster.engravingBooksGold,500);assert.equal(roster.knownGold,500);
  assert.equal(roster.counts.knownCharacters,3,'a missing book price is a book-list gap, not an unknown character');
});
test('roster total equals the character sums without books plus the once-per-server book gold',()=>{
  const values=[bookCharacter('검토바드1',2,{gems:[item(),item('gem:1')]}),bookCharacter('검토바드2',4,{gems:[item()]}),bookCharacter('검토바드3',3,{serverName:'카제로스'})];
  const roster=aggregateRosterValuations(values);assert.equal(roster.complete,true);
  const own=values.reduce((total,value)=>total+value.excludingSharedBooks.totalGold,0);
  assert.equal(own,3000);assert.equal(roster.engravingBooksGold,3500);assert.equal(roster.totalGold,own+roster.engravingBooksGold);
  assert.equal(roster.knownExpectedAcquisitionGold,0);assert.equal(roster.knownMarketReplacementGold,6500);
});
test('an unlisted engraving component keeps the book list incomplete even when the character sum is complete',()=>{
  const input=targets();input.components.engravings={status:'unavailable',items:[]};
  const value=calculateCharacterValuation(input,{now});assert.equal(value.excludingSharedBooks.complete,true);
  const roster=aggregateRosterValuations([value]);assert.equal(roster.engravingBooksComplete,false);assert.equal(roster.complete,false);
  assert.deepEqual(roster.engravingBooks,[]);assert.equal(roster.engravingBooksGold,0);assert.equal(roster.counts.unknownCharacters,0);
});
test('partial roster does not turn a failed character or missing shared engraving quote into zero',()=>{
  const good=calculateCharacterValuation(targets(),{now});const result=aggregateRosterValuations([good,{characterName:'조회실패',status:'unavailable'}]);
  assert.equal(result.complete,false);assert.equal(result.totalGold,null);assert.equal(result.knownGold,0);assert.equal(result.counts.unknownCharacters,1);
});
test('missing expected-cost components do not hide a fully known market subtotal',()=>{
  const input=targets();input.components.gems={status:'ok',items:[item()]};input.components.honing={status:'unavailable',items:[]};
  const result=calculateCharacterValuation(input,{now,quotes:{'gem-price':quote(100)}});
  assert.equal(result.marketReplacementGold,100);assert.equal(result.expectedAcquisitionGold,null);assert.equal(result.totalGold,null);
});
test('aggregate overflow fails closed and never returns an unsafe total',()=>{
  const input=targets();input.components.gems={status:'ok',items:[item(),item('gem:1')]};
  const result=calculateCharacterValuation(input,{now,quotes:{'gem-price':quote(Number.MAX_SAFE_INTEGER)}});
  assert.equal(result.status,'unavailable');assert.equal(result.reason,'value_overflow');assert.equal(result.totalGold,null);
});
test('current official book recipes are priced directly without an external cost model and details are not echoed',()=>{
  const input=targets();input.components.engravings={status:'ok',items:[{...item('engraving:0'),kind:'engraving',accountKey:'engraving:원한',grade:'유물',level:2,
    recipeVersion:'official-engraving-2026-09-16',bookQuotes:[{grade:'전설',quoteKey:'legend',quantity:20},{grade:'유물',quoteKey:'relic',quantity:10}]}]};
  const result=calculateCharacterValuation(input,{now,quotes:{legend:quote(10),relic:quote(100)},extraComponents:{bracelet:{status:'empty',items:[],details:'private'}}});
  assert.equal(result.marketReplacementGold,1200);assert.equal(result.totalGold,1200);assert(!JSON.stringify(result).includes('private'));
});
test('engraving sharing never crosses servers and missing server identity keeps the roster incomplete',()=>{
  const values=['루페온','카제로스'].map((serverName,index)=>{const input=targets();input.characterName+=index;input.serverName=serverName;
    input.components.engravings={status:'ok',items:[{id:'engraving:0',status:'ok',targetKey:String(index+1).repeat(64),accountKey:'engraving:원한',grade:'유물',level:4}]};
    return calculateCharacterValuation(input,{now,costs:{[String(index+1).repeat(64)]:{status:'ok',targetKey:String(index+1).repeat(64),modelVersion:'fixture',expectedAcquisitionGold:100,checkedAt:now}}});});
  const roster=aggregateRosterValuations(values);assert.equal(roster.totalGold,200);assert.equal(roster.engravingBooks.length,2);
  const missing={...values[0]};delete missing.serverName;assert.equal(aggregateRosterValuations([missing,values[1]]).complete,false);
  const legacy={...values[0]};delete legacy.excludingSharedBooks;
  const partial=aggregateRosterValuations([legacy,values[1]]);assert.equal(partial.complete,false);assert.equal(partial.counts.unknownCharacters,1);assert.equal(partial.knownGold,100);
});
