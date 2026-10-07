import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateGemOfferKernel, solveGemExpectationKernel } from '../src/arkgrid-gem-expectation.js';
import * as expectation from '../src/arkgrid-gem-expectation.js';
import { calculateWeightedOfferMarginals, getGemProcessingCandidates, createGemProcessingState, getInitialGemEffectPairs, applyGemProcessingOutcome } from '../src/arkgrid-gem-processing.js';

const close=(actual,expected,tolerance=1e-11)=>assert.ok(Math.abs(actual-expected)<=tolerance,`${actual} != ${expected}`);

test('grouped offer integration equals independent ordered enumeration including rejected offers',()=>{
  const candidates=[1,1,2,3,3,4].map((weight,index)=>({id:`o${index}`,weight}));
  const favorable=new Set(['o1','o4']);
  const applied=new Array(6).fill(0),bad=new Array(6).fill(0);let rejected=0;
  function enumerate(chosen,probability){
    if(chosen.length===4){const deny=chosen.every(index=>!favorable.has(candidates[index].id));if(deny)rejected+=probability;
      for(const index of chosen){applied[index]+=probability/4;if(deny)bad[index]+=probability/4;}return;}
    const total=candidates.reduce((sum,row,index)=>sum+(chosen.includes(index)?0:row.weight),0);
    for(let index=0;index<candidates.length;index++)if(!chosen.includes(index))enumerate([...chosen,index],probability*candidates[index].weight/total);
  }
  enumerate([],1);const result=calculateGemOfferKernel(candidates,[...favorable]);
  close(result.rejectedProbability,rejected);
  result.outcomes.forEach((row,index)=>{close(row.probability,applied[index]);close(row.rejectedJointProbability,bad[index]);});
});

const target=(levels=[5,5])=>({status:'ok',source:'official-arkgrid-gem-tooltip',name:'질서의 젬 : 안정',type:'order',typeName:'질서',subtype:'안정',
  grade:levels[0]+levels[1]+10>=19?'고대':'유물',completed:true,points:10+levels[0]+levels[1],corePoints:5,willpower:3,baseWillpower:8,willpowerEfficiency:5,
  options:[{name:'공격력',level:levels[0]},{name:'추가 피해',level:levels[1]}],targetKey:'a'.repeat(64)});

test('worker solver preserves rare targets, effect-order invariance and linear purchase cost',async t=>{
  assert.equal(typeof expectation.createGemExpectationSolver,'function');
  const solver=expectation.createGemExpectationSolver({precomputed:null});t.after(()=>solver.close());
  let ticks=0;const timer=setInterval(()=>ticks++,5);t.after(()=>clearInterval(timer));
  const one=await solver.getExpectedGemCost(target(),{grade:'영웅',purchaseGold:1000});
  assert.equal(one.status,'ok');assert(one.successProbability>0&&one.successProbability<.01);assert(ticks>0);
  const reverse=target();reverse.options.reverse();
  const two=await solver.getExpectedGemCost(reverse,{grade:'영웅',purchaseGold:2000});
  close(one.successProbability,two.successProbability);close(one.processingExpectedGold,two.processingExpectedGold);
  close(two.totalExpectedGold-one.totalExpectedGold,1000*one.expectedStartingGems,1e-7);
  close(one.purchaseExpectedGold+one.processingExpectedGold,one.totalExpectedGold,1e-7);
  assert(one.assumptions.some(text=>text.includes('레벨')));assert(one.assumptions.some(text=>text.includes('최적')));
});

test('worker boundary rejects unknown input, supports cancellation, and closes without yielding a cost',async()=>{
  assert.equal(typeof expectation.createGemExpectationSolver,'function');
  const solver=expectation.createGemExpectationSolver();
  try{
    for(const input of [null,{...target(),points:19},{...target(),completed:false},{...target(),options:[target().options[0],target().options[0]]}])
      assert.equal((await solver.getExpectedGemCost(input,{purchaseGold:1000})).status,'unavailable');
    for(const purchaseGold of [0,-1,null,Infinity,'1000'])assert.equal((await solver.getExpectedGemCost(target(),{purchaseGold})).status,'unavailable');
    assert.equal((await solver.getExpectedGemCost(target(),{grade:'고급',purchaseGold:1000})).reason,'starting_grade_unavailable');
    const controller=new AbortController();controller.abort();
    assert.equal((await solver.getExpectedGemCost(target(),{purchaseGold:1000,signal:controller.signal})).reason,'calculation_cancelled');
    const pending=solver.getExpectedGemCost(target(),{purchaseGold:1000});solver.close();assert.equal((await pending).reason,'solver_closed');
  }finally{solver.close();}
});

test('two lower-bound rounds agree with the separate official transition engine and direct ordered-offer enumeration',()=>{
  const desired=['공격력','추가 피해'];
  const exact=state=>state.points[0]>=2&&state.points[1]>=1&&state.points[2]>=1&&state.points[3]>=1&&desired.every(name=>state.effects.includes(name));
  const marginals=new Map();
  const marginal=state=>{const candidates=getGemProcessingCandidates(state).candidates,key=candidates.map(row=>row.id).join('|');
    if(!marginals.has(key))marginals.set(key,calculateWeightedOfferMarginals(candidates).outcomes);return {candidates,rows:marginals.get(key)};};
  let probability=0,cost=1,count=1,rerolls=0;
  for(const pair of getInitialGemEffectPairs('안정').pairs){
    const state={...createGemProcessingState({grade:'영웅',subtype:'안정',effects:pair.effects}).state,processedCount:7,remainingAttempts:2,rerollsRemaining:0};
    for(const first of marginal(state).rows)for(const branch of applyGemProcessingOutcome(state,first.id).branches){
      const mass=pair.probability*first.probability*branch.probability,next=branch.state;
      if(exact(next)){probability+=mass;continue;}
      const {candidates,rows}=marginal(next),wins=new Map(rows.map(row=>[row.id,applyGemProcessingOutcome(next,row.id).branches.filter(end=>exact(end.state)).reduce((sum,end)=>sum+end.probability,0)]));
      if([...wins.values()].every(value=>value===0))continue;
      cost+=mass*(1+next.costModifier);count+=mass;
      const win=rows.reduce((sum,row)=>sum+row.probability*wins.get(row.id),0);
      if(!next.rerollsRemaining){probability+=mass*win;continue;}
      // In this two-round fixture rerolls are earned only by an unchanged first
      // round. A one-step improvement includes every upward target outcome.
      const total=candidates.reduce((sum,row)=>sum+row.weight,0);let q=0;
      function enumerate(selected,weight,p){
        if(selected.length===4){q+=p;return;}
        for(let index=0;index<candidates.length;index++)if(!selected.includes(index)&&wins.get(candidates[index].id)===0)
          enumerate([...selected,index],weight+candidates[index].weight,p*candidates[index].weight/(total-weight));
      }
      enumerate([],0,1);probability+=mass*win*(1+q);rerolls+=mass*q;
    }
  }
  const result=solveGemExpectationKernel({target:[2,1,1,1],attempts:2,rerolls:0,effectLevelRule:'preserve'});
  close(result.successProbability,probability);close(result.processingGoldUnits,cost);close(result.processingCount,count);close(result.rerollCount,rerolls);
});

test('asymmetric option lower bounds preserve name-row order and distinguish all four axes',async t=>{
  const service=expectation.createGemExpectationService();t.after(()=>service.close());
  const one=target([3,5]),reverse=structuredClone(one);reverse.options.reverse();
  const a=await service.get(one,{purchaseGold:500}),b=await service.get(reverse,{purchaseGold:500});
  assert.equal(a.status,'ok');assert.deepEqual(a,b);
  const different=structuredClone(one);different.willpowerEfficiency=4;different.willpower=4;different.options[0].level=4;
  const c=await service.get(different,{purchaseGold:500});assert.equal(c.status,'ok');assert.notEqual(a.successProbability,c.successProbability);
  const rare=await service.get(one,{grade:'희귀',purchaseGold:500});assert.equal(rare.status,'ok');assert.notEqual(rare.successProbability,a.successProbability);
});

test('bounded worker deadline and queue return unavailable rather than zero or partial costs',async t=>{
  const timed=expectation.createGemExpectationService({timeoutMs:1,precomputed:null});t.after(()=>timed.close());
  const result=await timed.get(target(),{purchaseGold:1000});assert.equal(result.reason,'calculation_timeout');assert.equal(result.totalExpectedGold,null);
  const limited=expectation.createGemExpectationService({maxQueued:1,precomputed:null});t.after(()=>limited.close());
  const first=limited.get(target(),{purchaseGold:1000}),second=limited.get(target([3,5]),{purchaseGold:1000});
  assert.equal((await limited.get(target([4,5]),{purchaseGold:1000})).reason,'calculation_busy');
  limited.close();assert.equal((await first).reason,'solver_closed');assert.equal((await second).reason,'solver_closed');
});

test('sparse targets fail closed and cancelling one consumer does not cancel shared work',async t=>{
  const service=expectation.createGemExpectationService();t.after(()=>service.close());
  const malformed=target();malformed.options=new Array(2);
  assert.equal((await service.get(malformed,{purchaseGold:1000})).reason,'invalid_request');
  assert.throws(()=>solveGemExpectationKernel({target:new Array(4),attempts:9,rerolls:2,effectLevelRule:'preserve'}));
  const controller=new AbortController(),cancelled=service.get(target(),{purchaseGold:1000,signal:controller.signal});
  const retained=service.get(target(),{purchaseGold:1000});controller.abort();
  assert.equal((await cancelled).reason,'calculation_cancelled');assert.equal((await retained).status,'ok');
});

test('one processing round counts every result above the lower bound with the full trial cost',()=>{
  const initial=createGemProcessingState({grade:'영웅',subtype:'안정',effects:['공격력','추가 피해']}).state;
  initial.processedCount=8;initial.remainingAttempts=1;
  const candidates=getGemProcessingCandidates(initial).candidates;
  const p=calculateWeightedOfferMarginals(candidates).outcomes.filter(row=>/^axis0\.plus[1-4]$/.test(row.id)).reduce((sum,row)=>sum+row.probability,0)/6;
  const result=solveGemExpectationKernel({target:[2,1,1,1],attempts:1,rerolls:0,effectLevelRule:'preserve'});
  close(result.successProbability,p);close(result.processingGoldUnits,1);close(result.processingCount,1);
});

test('grade comparison evaluates both starts and switches the chosen grade when purchase prices change',async t=>{
  const service=expectation.createGemExpectationService();t.after(()=>service.close());
  assert.equal(typeof service.getBest,'function');
  const input=target();
  const result=await service.getBest(input,{purchaseGoldByGrade:{희귀:1000,영웅:1000}});
  assert.equal(result.status,'ok');assert.equal(result.comparison,'at-least');assert.equal(result.comparisonComplete,true);
  assert.deepEqual(result.availableGrades,['희귀','영웅']);assert.equal(result.alternatives.length,2);
  for(const row of result.alternatives){
    const independent=await service.get(input,{grade:row.startingGrade,purchaseGold:1000});assert.deepEqual(row,independent);
  }
  assert.equal(result.selected.startingGrade,'영웅');assert.equal(result.totalExpectedGold,Math.min(...result.alternatives.map(row=>row.totalExpectedGold)));
  const changed=await service.getBest(input,{purchaseGoldByGrade:{희귀:1000,영웅:1000000}});
  assert.equal(changed.selected.startingGrade,'희귀');assert.equal(changed.comparisonComplete,true);
  close(changed.alternatives[0].successProbability,result.alternatives[0].successProbability);
  close(changed.alternatives[1].processingExpectedGold,result.alternatives[1].processingExpectedGold);
});

test('missing one starting price remains a disclosed incomplete comparison and absent or invalid inputs never give zero cost',async t=>{
  const service=expectation.createGemExpectationService();t.after(()=>service.close());assert.equal(typeof service.getBest,'function');
  const partial=await service.getBest(target(),{purchaseGoldByGrade:{영웅:1000}});
  assert.equal(partial.status,'ok');assert.equal(partial.comparisonComplete,false);assert.deepEqual(partial.availableGrades,['영웅']);
  assert.equal(partial.alternatives[0].reason,'missing_quote');assert.equal(partial.alternatives[0].totalExpectedGold,null);
  const missing=await service.getBest(target(),{purchaseGoldByGrade:{희귀:null,영웅:null}});
  assert.equal(missing.status,'unavailable');assert.equal(missing.selected,null);assert.equal(missing.totalExpectedGold,null);
  for(const value of [null,[],{희귀:0,영웅:1000},{희귀:'1000'},{영웅:NaN},{고급:1000}]){
    const invalid=await service.getBest(target(),{purchaseGoldByGrade:value});assert.equal(invalid.reason,'invalid_request');assert.equal(invalid.totalExpectedGold,null);
  }
  assert.equal((await service.getBest({...target(),points:19},{purchaseGoldByGrade:{희귀:1000,영웅:1000}})).reason,'invalid_request');
});

test('grade comparisons preserve consumer cancellation and service closure',async()=>{
  const service=expectation.createGemExpectationService();assert.equal(typeof service.getBest,'function');
  const controller=new AbortController();
  const pending=service.getBest(target(),{purchaseGoldByGrade:{희귀:1000,영웅:1000},signal:controller.signal});controller.abort();
  const stopped=await pending;assert.equal(stopped.reason,'calculation_cancelled');assert.equal(stopped.totalExpectedGold,null);
  const retained=service.getBest(target(),{purchaseGoldByGrade:{희귀:1000,영웅:1000}});service.close();
  assert.equal((await retained).reason,'solver_closed');assert.equal((await service.getBest(target(),{purchaseGoldByGrade:{영웅:1000}})).reason,'solver_closed');
});

test('at-least success leaves the all-max target unchanged and increases a lower target without dropping effect identity',async t=>{
  const full=solveGemExpectationKernel({target:[5,5,5,5],attempts:9,rerolls:2,effectLevelRule:'preserve'});
  close(full.successProbability,0.00037117444181394496);close(full.processingGoldUnits,5.395077257061246);
  const lower=solveGemExpectationKernel({target:[5,5,4,4],attempts:9,rerolls:2,effectLevelRule:'preserve'});
  assert(lower.successProbability>0.0006452587219989615);assert(lower.successProbability>full.successProbability);
  close(lower.successProbability,0.0016950064024804648);
  const service=expectation.createGemExpectationService();t.after(()=>service.close());
  const result=await service.get(target([4,4]),{purchaseGold:1000});
  assert.equal(result.comparison,'at-least');assert.match(result.policyVersion,/at-least/);assert.match(result.modelVersion,/at-least/);
  assert(result.assumptions.some(text=>text.includes('이상')));assert(!result.assumptions.some(text=>text.includes('정확히 같은')));
});

test('the precomputed table covers every reachable key, matches the kernel, and answers without the worker',async t=>{
  const {default:table}=await import('../src/data/gem-expectation-table.json',{with:{type:'json'}});
  assert.equal(table.model,expectation.GEM_EXPECTATION_MODEL);
  let expected=0;
  for(const grade of ['희귀','영웅'])for(let e=1;e<=5;e++)for(let c=1;c<=5;c++)for(let low=1;low<=5;low++)for(let high=low;high<=5;high++){
    expected++;assert.ok(table.entries[`${grade}|${e},${c},${low},${high}`],`${grade}|${e},${c},${low},${high}`);
  }
  assert.equal(Object.keys(table.entries).length,expected);
  const fresh=solveGemExpectationKernel({target:[3,3,3,3],attempts:9,rerolls:2,effectLevelRule:'preserve'});
  for(const key of ['successProbability','processingGoldUnits','rerollCount'])assert.ok(Math.abs(fresh[key]-table.entries['영웅|3,3,3,3'][key])<1e-12,key);
  const solver=expectation.createGemExpectationSolver();t.after(()=>solver.close());
  const started=performance.now();
  const one=await solver.getExpectedGemCost(target(),{grade:'영웅',purchaseGold:1000});
  assert.equal(one.status,'ok');assert.ok(performance.now()-started<50,'served from the table');
  const stale=expectation.createGemExpectationSolver({precomputed:{model:'other-model',entries:table.entries}});t.after(()=>stale.close());
  const ticksBefore=performance.now();const viaWorker=await stale.getExpectedGemCost(target(),{grade:'영웅',purchaseGold:1000});
  assert.equal(viaWorker.status,'ok');assert.ok(Math.abs(viaWorker.successProbability-one.successProbability)<1e-12);assert.ok(performance.now()-ticksBefore>=5);
});
